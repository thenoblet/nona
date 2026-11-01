import { readFile } from "node:fs/promises";
import { expect, request as apiRequest, test, type Locator, type Page } from "@playwright/test";
import { contentDefaults } from "../src/lib/content/defaults";
import type { RsvpRecord } from "../src/lib/data/types";
import { renderRsvpConfirmation } from "../src/lib/email/rsvp-confirmation";
import { closeStorage, seedMoment, testSql } from "./media-seed";

// No page may scroll sideways on any phone, tablet or laptop (Noblet, 30 Oct). The admin's data
// pages need a Cloudflare Access sign-in, which this production build can't fake, so only the
// admin's refusal is checked here; the signed-in pages are checked against the dev server.
const widths = [320, 360, 390, 768, 1024, 1440];

// Each page's own content, checked first, so a blank or error page can't pass by being narrow.
const heading = (name: RegExp) => (page: Page) => page.getByRole("heading", { level: 1, name });
const pages: { path: string; marker: (page: Page) => Locator }[] = [
  { path: "/", marker: heading(/Noblet & Nancy/) },
  { path: "/home?mode=before", marker: heading(/Noblet & Nancy/) },
  { path: "/home?mode=day", marker: heading(/Noblet & Nancy/) },
  { path: "/home?mode=after", marker: heading(/Thank you/) },
  { path: "/rsvp", marker: heading(/Kindly respond/) },
  { path: "/album", marker: heading(/Capture it with us/) },
  { path: "/today", marker: heading(/the day/) },
  { path: "/wishes", marker: heading(/Leave us a wish/) },
  // The phone and TV layouts each show their own caption; the one on screen must be there.
  { path: "/slideshow", marker: (page) => page.getByText(/^Shared by /).filter({ visible: true }) },
  { path: "/admin/rsvps", marker: (page) => page.getByText("This page is for the couple.") },
  { path: "/admin/content/celebrations", marker: (page) => page.getByText("This page is for the couple.") },
];

/**
 * The slideshow shows the album's moments listed past the TV's delay: a few, one shared under a
 * name at its 80-character limit, so its captions are checked at their longest. Its list is kept
 * 15 s, so this waits until it holds them.
 */
async function seedSlideshow(baseURL: string | undefined): Promise<void> {
  const sql = testSql();
  const api = await apiRequest.newContext({ baseURL });
  try {
    await sql`delete from settings where key = 'slideshow_delay_seconds'`;
    const longName = "Nana Kwame Asante-Boakye Ofori-Mensah Agyeman-Duah Owusu-Ansah Darko-Sarpong Kpo";
    const ids: string[] = [];
    for (const [index, uploaderName] of [longName, "Ama Owusu", "Kojo Antwi"].entries()) {
      ids.push((await seedMoment(sql, { index, secondsAgo: 600 + index * 5, uploaderName, celebration: "thanks" })).id);
    }
    const shown = async () => ((await (await api.get("/slideshow/slides.json")).json()) as { slides: { id: string }[] }).slides.map((slide) => slide.id);
    await expect.poll(shown, { timeout: 20_000, intervals: [500] }).toEqual(expect.arrayContaining(ids));
  } finally {
    await api.dispose();
    await sql.end();
    closeStorage();
  }
}

for (const { path, marker } of pages) {
  test.describe(path, () => {
    if (path === "/slideshow") test.beforeAll(async ({}, testInfo) => seedSlideshow(testInfo.project.use.baseURL));
    for (const width of widths) {
      test(`does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(marker(page)).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(scrollWidth, `${path} is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
      });
    }
  });
}

// The RSVP confirmations fit a phone too: its mail app shows an email at the screen's width
// (Ruling CA). Rendered as the confirmation job renders them, in Georgia as Gmail shows them (it
// strips web fonts, and Georgia is the wider), with the header photo from the build's own file.
const EMAIL_SITE = "https://wedding.example";
const [ceremony, reception, thanks] = contentDefaults.celebrations;

function reply(answers: RsvpRecord["answers"]): RsvpRecord {
  return {
    id: "r1",
    fullName: "Ama Owusu",
    phone: "024 000 0000",
    email: "ama@example.com",
    partySize: "Just me",
    answers,
    receivedAt: "2026-10-29T09:41:07.123Z",
    supersededAt: null,
    emailStatus: "queued",
    flags: [],
  };
}

const emails = {
  "the confirmation for a guest who is coming, with their personal link": () =>
    renderRsvpConfirmation(
      reply({ [ceremony.id]: "yes", [reception.id]: "yes", [thanks.id]: "no" }),
      contentDefaults,
      EMAIL_SITE,
      `${EMAIL_SITE}/my/made-up-token-for-the-width-check-000000000`,
    ),
  "the confirmation for a guest who can come to none": () =>
    renderRsvpConfirmation(reply({ [ceremony.id]: "no", [reception.id]: "no", [thanks.id]: "no" }), contentDefaults, EMAIL_SITE),
};

for (const [name, render] of Object.entries(emails)) {
  test.describe(name, () => {
    // Every width the global constraints list, 414 and 1280 included.
    for (const width of [320, 360, 390, 414, 768, 1024, 1280, 1440]) {
      test(`does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        const header = await readFile("public/email/header.jpg");
        await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
        await page.route(`${EMAIL_SITE}/email/header.jpg`, (route) => route.fulfill({ body: header, contentType: "image/jpeg" }));
        await page.setContent((await render()).html, { waitUntil: "load" });
        await expect(page.getByRole("heading", { level: 1, name: "Dear Ama Owusu," })).toBeVisible();
        const { scrollWidth, innerWidth, codeLines } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          // The reception's GhanaPost GPS code, which may move to a line of its own but never splits.
          codeLines: [...document.querySelectorAll("span")].find((span) => span.textContent === "AX-0084-3317")?.getClientRects().length,
        }));
        expect(scrollWidth, `${name} is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
        expect(codeLines).toBe(1);
      });
    }
  });
}
