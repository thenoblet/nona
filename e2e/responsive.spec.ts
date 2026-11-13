import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, request as apiRequest, test, type Locator, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { HEADER_IMAGE } from "../src/emails/components/header-image";
import { contentDefaults } from "../src/lib/content/defaults";
import type { RsvpRecord } from "../src/lib/data/types";
import { renderRsvpConfirmation } from "../src/lib/email/rsvp-confirmation";
import { closeStorage, seedMoment, testSql } from "./media-seed";

// No page may scroll sideways on any phone, tablet or laptop (Noblet, 30 Oct). The admin's data
// pages need a Cloudflare Access sign-in, which this production build can't fake, so only the
// admin's refusal is checked here; the signed-in pages are checked against the dev server.
// Every width the global constraints list.
const widths = [320, 360, 390, 414, 768, 1024, 1280, 1440];

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
  { path: "/programme", marker: heading(/Order of the day/) },
  { path: "/stay", marker: heading(/Where to stay/) },
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

/** The page, once its fonts are in, is no wider than its window. */
async function expectNoSidewaysScroll(page: Page, what: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${what} is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
}

for (const { path, marker } of pages) {
  test.describe(path, () => {
    if (path === "/slideshow") test.beforeAll(async ({}, testInfo) => seedSlideshow(testInfo.project.use.baseURL));
    for (const width of widths) {
      test(`does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(marker(page)).toBeVisible();
        await expectNoSidewaysScroll(page, path);
      });
    }
  });
}

/** A name at the 80-character limit, as long as a guest's can be. */
const LONGEST_NAME = "Nana Kwame Asante-Boakye Ofori-Mensah Agyeman-Duah Owusu-Ansah Darko-Sarpong Kpo";

test.describe("a personal link's question, for a guest whose name is at the 80-character limit", () => {
  let token = "";
  test.beforeAll(async () => {
    const sql = testSql();
    try {
      token = randomBytes(32).toString("base64url");
      await sql`insert into guests (display_name, link_token) values (${LONGEST_NAME}, ${token})`;
    } finally {
      await sql.end();
    }
  });
  for (const width of widths) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/my/${token}/confirm`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1, name: `Is this you, ${LONGEST_NAME}?` })).toBeVisible();
      await expectNoSidewaysScroll(page, "/my/<token>/confirm");
    });
  }
});

test.describe("the album with a moment open in the viewer", () => {
  let momentId = "";
  test.beforeAll(async () => {
    const sql = testSql();
    try {
      momentId = (await seedMoment(sql, { index: 0, secondsAgo: 300, uploaderName: LONGEST_NAME })).id;
    } finally {
      await sql.end();
      closeStorage();
    }
  });
  for (const width of widths) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/album#m/${momentId}`, { waitUntil: "networkidle" });
      const viewer = page.getByRole("dialog", { name: "Moment" });
      await expect(viewer.getByText(`Shared by ${LONGEST_NAME}`)).toBeVisible();
      await expectNoSidewaysScroll(page, "/album with the viewer open");
    });
  }
});

test.describe("the album with an upload on its way", () => {
  let fixtures = "";
  test.beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "nona-responsive-e2e-"));
  });
  test.afterAll(async () => {
    await rm(fixtures, { recursive: true, force: true });
  });
  for (const width of widths) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      // The photo's part waits, unanswered, so its card stays on its way.
      const held: Route[] = [];
      await page.route(/\/nona-private\/originals\//, (route) => (route.request().method() === "PUT" ? void held.push(route) : route.continue()));
      await page.goto("/album?mode=before", { waitUntil: "networkidle" });
      await expect(page.getByRole("main").getByText("Choose photos & videos")).toBeVisible();
      const photo = join(fixtures, `on-its-way-${width}.jpg`);
      await sharp(randomBytes(300 * 200 * 3), { raw: { width: 300, height: 200, channels: 3 } }).jpeg().toFile(photo);
      await page.getByRole("main").getByLabel("Choose photos & videos").setInputFiles(photo);
      await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect(page.getByRole("region", { name: /^Your / })).toBeVisible();
      await expectNoSidewaysScroll(page, "/album with an upload card");
      await Promise.all(held.map((route) => route.abort().catch(() => {})));
    });
  }
});

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

/** The all-declined email, which shows no celebration's place (only its name and answer). */
const COMING_TO_NONE = "the confirmation for a guest who can come to none";

const emails = {
  "the confirmation for a guest who is coming, with their personal link": () =>
    renderRsvpConfirmation(
      reply({ [ceremony.id]: "yes", [reception.id]: "yes", [thanks.id]: "no" }),
      contentDefaults,
      EMAIL_SITE,
      `${EMAIL_SITE}/my/made-up-token-for-the-width-check-000000000`,
    ),
  [COMING_TO_NONE]: () =>
    renderRsvpConfirmation(reply({ [ceremony.id]: "no", [reception.id]: "no", [thanks.id]: "no" }), contentDefaults, EMAIL_SITE),
};

for (const [name, render] of Object.entries(emails)) {
  test.describe(name, () => {
    for (const width of widths) {
      test(`does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        const header = await readFile(`public${HEADER_IMAGE}`);
        await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
        await page.route(`${EMAIL_SITE}${HEADER_IMAGE}`, (route) => route.fulfill({ body: header, contentType: "image/jpeg" }));
        await page.setContent((await render()).html, { waitUntil: "load" });
        await expect(page.getByRole("heading", { level: 1, name: "Dear Ama Owusu," })).toBeVisible();
        const { scrollWidth, innerWidth, codeLines } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          // The reception's GhanaPost GPS code, which may move to a line of its own but never splits;
          // a guest coming to none sees no place at all.
          codeLines: [...document.querySelectorAll("span")].find((span) => span.textContent === "AX-0084-3317")?.getClientRects().length,
        }));
        expect(scrollWidth, `${name} is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
        expect(codeLines).toBe(name === COMING_TO_NONE ? undefined : 1);
      });
    }
  });
}
