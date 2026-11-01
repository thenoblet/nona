import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";
import { TEST_STORAGE_ENV } from "../test/env";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";
import { closeStorage, seedMoment, testSql } from "./media-seed";

/*
 * The slideshow on the album's real moments (Task 20), against the production build, the test
 * database, MinIO and the media worker. Moments are seeded listed ten minutes ago, past the TV's
 * default delay of three minutes, unless a test says otherwise.
 *
 * The slideshow's list is kept 15 s (src/app/slideshow/slides.ts), and rows written straight into
 * the database drop nothing, so a test that seeds waits until the list shows what it seeded.
 */

// The venue TV runs all evening with nobody at it. The operator clicks Full screen (README) and
// maybe the photo, then walks away: nothing a click leaves behind may stay on screen or turn the
// space bar into something other than pause.
test.use({ viewport: { width: 1920, height: 1080 } });

const sql = testSql();
const TEN_MINUTES = 600;

type SlidesBody = { slides: { id: string; src: string; by: string | null; detail: string }[] };

async function slideIds(request: APIRequestContext): Promise<string[]> {
  const response = await request.get("/slideshow/slides.json");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as SlidesBody).slides.map((slide) => slide.id);
}

/** Waits, at most the list's 15 s lifetime and a little, until slides.json holds these moments, newest first. */
async function slidesSettleOn(request: APIRequestContext, ids: string[]): Promise<void> {
  await expect.poll(() => slideIds(request), { timeout: 20_000, intervals: [500] }).toEqual(ids);
}

/** Five moments from five guests, newest first, listed a few seconds apart ten minutes ago. */
async function seedFive(): Promise<string[]> {
  const names = ["Ama Owusu", "Kojo Antwi", "Efua Asante", "Yaw Boateng", "Abena Darko"];
  const ids: string[] = [];
  for (const [index, name] of names.entries()) {
    ids.push((await seedMoment(sql, { index, secondsAgo: TEN_MINUTES + index * 5, uploaderName: name })).id);
  }
  return ids;
}

/** The couple's browser, signed in through Cloudflare Access. */
async function couple(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
}

async function phone(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

/** Hides a moment from the couple's Photos page, as they would on the night. */
async function hideFromAdmin(page: Page, sharer: string): Promise<void> {
  await page.goto("/admin/photos");
  await page.getByRole("list", { name: "Album items" }).getByRole("button", { name: new RegExp(`^Photo from ${sharer}`) }).click();
  const panel = page.getByRole("complementary", { name: "Selected item" });
  await panel.getByRole("button", { name: "Hide from the album" }).click();
  await expect(panel.getByText("Hidden. Guests can no longer see it.")).toBeVisible();
}

const currentPhoto = (page: Page) => page.locator('section [aria-hidden="false"] img:not([alt=""])').getAttribute("alt");

test.beforeEach(async () => {
  await sql`delete from upload_events`;
  await sql`delete from media where purpose = 'album'`;
  await sql`delete from settings where key = 'slideshow_delay_seconds'`;
});

test.afterEach(async () => {
  await sql`delete from settings where key = 'slideshow_delay_seconds'`;
});

test.afterAll(async () => {
  await sql.end();
  closeStorage();
});

test("the TV controls fade after the full-screen click, and space after a click on the photo pauses", async ({ page, request }) => {
  await slidesSettleOn(request, await seedFive());
  await page.goto("/slideshow");
  // Only drawn once the page's script runs, so the clicks below are handled.
  const fullScreen = page.getByRole("button", { name: "Full screen" });
  await expect(fullScreen).toBeVisible();

  // The controls hide after three seconds without a move, and on a slow machine they can hide
  // before the click, which then lands on the photo's tap area. The operator's mouse reaches the
  // button first, waking them: so does this one, and it tries again until the click lands. Each
  // try moves to a new point, so the browser sends a move. A click that times out was never sent.
  const controls = page.getByRole("group", { name: "Slideshow controls" });
  const button = await fullScreen.boundingBox();
  if (!button) throw new Error("The Full screen button has no size");
  let nudge = 0;
  await expect(async () => {
    nudge = 1 - nudge;
    await page.mouse.move(button.x + button.width / 2 + nudge, button.y + button.height / 2);
    await fullScreen.click({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.waitForTimeout(4000);
  await expect(controls).toHaveCSS("opacity", "0", { timeout: 1000 });

  // A click on the right of the photo moves on; space then pauses, and nothing moves after that.
  await page.mouse.click(1250, 540);
  const photo = await currentPhoto(page);
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Play the slideshow" })).toHaveCount(1);
  await page.waitForTimeout(8000); // longer than a photo's six seconds
  expect(await currentPhoto(page)).toBe(photo);
});

test("the TV and a phone show the album's own moments at their viewing size, with who shared each and no placeholder text", async ({
  browser,
  baseURL,
  page,
  request,
}) => {
  const five = await seedFive();
  // The newest of all, shared without a name: its caption names no one.
  const unnamed = await seedMoment(sql, { index: 8, secondsAgo: TEN_MINUTES - 60, uploaderName: null });
  await slidesSettleOn(request, [unnamed.id, ...five]);

  const answer = (await (await request.get("/slideshow/slides.json")).json()) as SlidesBody;
  expect(answer.slides[0]).toMatchObject({ src: unnamed.view, by: null, detail: "Reception · 9 min ago" });
  for (const slide of answer.slides) expect(`${slide.by ?? ""} ${slide.detail}`).not.toMatch(/[[\]]/);

  await page.goto("/slideshow");
  const stage = page.getByRole("region", { name: "Latest shared moments" });
  const shown = stage.locator('[aria-hidden="false"] img:not([alt=""])');
  await expect(shown).toHaveAttribute("src", unnamed.view);
  await expect(shown).toHaveAttribute("alt", "Photo");
  // Its size, from the album, so the browser knows its shape before it loads.
  await expect(shown).toHaveAttribute("width", "1200");
  await expect(shown).toHaveAttribute("height", "900");
  await expect(stage.getByText("Reception · 9 min ago").filter({ visible: true })).toBeVisible();
  await expect(stage.getByText(/^Shared by /).filter({ visible: true })).toHaveCount(0);
  // The four newest, beside the QR code, from the same files.
  await expect(page.getByRole("list", { name: "Recently shared" }).locator("img")).toHaveCount(4);

  // Once the page's script runs (it draws Full screen), the arrow key moves on to the next moment.
  await expect(page.getByRole("button", { name: "Full screen" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(stage.getByText("Shared by Ama Owusu").filter({ visible: true })).toBeVisible();
  const visibleText = await page.locator("body").innerText();
  expect(visibleText).not.toMatch(/\[[^\]]*\]/);
  const labels = await page.locator("[alt], [aria-label]").evaluateAll((elements) =>
    elements.map((element) => `${element.getAttribute("alt") ?? ""} ${element.getAttribute("aria-label") ?? ""}`).join("\n"),
  );
  expect(labels).not.toMatch(/\[[^\]]*\]/);

  // A phone held upright: the photo full screen, the same moments.
  const context = await phone(browser, baseURL);
  try {
    const phonePage = await context.newPage();
    await phonePage.goto("/slideshow");
    const phoneStage = phonePage.getByRole("region", { name: "Latest shared moments" });
    await expect(phoneStage.locator('[aria-hidden="false"] img:not([alt=""])')).toHaveAttribute("src", unnamed.view);
    await expect(phoneStage.getByText("Reception · 9 min ago").filter({ visible: true })).toBeVisible();
    expect(await phonePage.locator("body").innerText()).not.toMatch(/\[[^\]]*\]/);
  } finally {
    await context.close();
  }
});

test("a TV delay written straight into the database reaches the next answer: the kept list is keyed by its delay", async ({ request }) => {
  const recent = await seedMoment(sql, { index: 0, secondsAgo: 60, uploaderName: "Esi Quaye" });
  const older = await seedMoment(sql, { index: 1, secondsAgo: TEN_MINUTES, uploaderName: "Yaa Asantewaa" });
  // Under the default three minutes the moment listed a minute ago waits.
  await slidesSettleOn(request, [older.id]);

  // No save through the admin, so nothing drops the kept list: a delay no other test uses (37 s)
  // is a list of its own, read afresh on the very next request.
  await sql`insert into settings (key, value) values ('slideshow_delay_seconds', '37'::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  expect(await slideIds(request)).toEqual([recent.id, older.id]);

  await sql`delete from settings where key = 'slideshow_delay_seconds'`;
  expect(await slideIds(request)).toEqual([older.id]);
});

test.describe("on the night", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a photo a guest shares stays off the TV for the delay, and reaches it once the couple set the delay to 0", async ({
    browser,
    baseURL,
    request,
  }) => {
    const fixtures = await mkdtemp(join(tmpdir(), "nona-slideshow-e2e-"));
    const guest = await phone(browser, baseURL);
    const admin = await couple(browser, baseURL);
    try {
      // A guest gives their name and shares a photo from the album page; the worker makes it ready.
      const phonePage = await guest.newPage();
      await phonePage.goto("/album?mode=before");
      const main = phonePage.getByRole("main");
      await main.getByRole("button", { name: "Add your name" }).click();
      await main.getByLabel("Your name").fill("Adwoa Sarpong");
      await main.getByRole("button", { name: "Save" }).click();
      await expect(main.getByText("Sharing as Adwoa Sarpong")).toBeVisible();
      const path = join(fixtures, "first-dance.jpg");
      await sharp(randomBytes(600 * 400 * 3), { raw: { width: 600, height: 400, channels: 3 } }).jpeg({ quality: 80 }).toFile(path);
      await main.getByLabel("Take a photo").setInputFiles(path);
      await expect(phonePage.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(async () => (await sql`select status from media where uploader_name = 'Adwoa Sarpong'`)[0]?.status, { timeout: 60_000 })
        .toBe("ready");
      const [{ id, derived }] = await sql<{ id: string; derived: Record<string, string> }[]>`
        select id, derived from media where uploader_name = 'Adwoa Sarpong'`;

      // Listed just now: under the default three minutes it stays off the TV.
      expect(await slideIds(request)).not.toContain(id);

      // The couple set the TV delay to 0 on their Photos page.
      const adminPage = await admin.newPage();
      await adminPage.goto("/admin/photos");
      // Visible only: while the page streams in, a hidden copy of the card can sit beside it.
      const card = adminPage.locator('[data-switch="tv-delay"]').filter({ visible: true });
      await expect(card.getByText("Default", { exact: true })).toBeVisible();
      await card.getByLabel("Seconds").fill("0");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Saved. New moments reach the TV at once.")).toBeVisible();
      // A new delay is a list of its own (and the save drops the kept ones too): the next answer holds the photo.
      expect(await slideIds(request)).toContain(id);

      const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await tv.goto(`${baseURL}/slideshow`);
        const stage = tv.getByRole("region", { name: "Latest shared moments" });
        await expect(stage.getByText("Shared by Adwoa Sarpong").filter({ visible: true })).toBeVisible();
        await expect(stage.locator('[aria-hidden="false"] img:not([alt=""])')).toHaveAttribute(
          "src",
          `${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${derived.view}`,
        );
        // Listed when the worker made it ready, moments ago, under the day it was taken (More moments
        // outside the wedding weekend).
        await expect(stage.getByText(/ · (just now|\d+ min ago)$/).filter({ visible: true })).toBeVisible();
      } finally {
        await tv.close();
      }
    } finally {
      await guest.close();
      await admin.close();
      await rm(fixtures, { recursive: true, force: true });
    }
  });

  test("a moment hidden after the TV has it leaves slides.json without waiting out the kept list: removed by its guest, or hidden by the couple (Review Focus 3)", async ({
    browser,
    baseURL,
    request,
  }) => {
    const guest = await phone(browser, baseURL);
    const admin = await couple(browser, baseURL);
    try {
      const guestResponse = await guest.request.post("/api/guest", { data: { displayName: "Kofi Ansah" } });
      expect(guestResponse.ok()).toBe(true);
      const { guestId } = await guestResponse.json();
      const theirs = await seedMoment(sql, { index: 0, secondsAgo: TEN_MINUTES, uploaderName: "Kofi Ansah", guestId });
      const toHide = await seedMoment(sql, { index: 1, secondsAgo: TEN_MINUTES + 5, uploaderName: "Selorm Agbeko" });
      const kept = await seedMoment(sql, { index: 2, secondsAgo: TEN_MINUTES + 10, uploaderName: "Dzifa Kpodo" });
      await slidesSettleOn(request, [theirs.id, toHide.id, kept.id]);

      // The list is kept for 15 s: a moment listed straight into the database (no hide, nothing to
      // drop the list) isn't in the next answer...
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Listed well before the others (the wait above can take seconds), so it sorts last.
      const late = await seedMoment(sql, { index: 3, secondsAgo: TEN_MINUTES + 120, uploaderName: "Nana Asante" });
      expect(await slideIds(request)).toEqual([theirs.id, toHide.id, kept.id]);

      // ...but a hide drops it: the guest's own "Remove my upload" (a route handler). Read afresh
      // within moments, long before the list's own 15 s are up: the late moment comes in with it.
      // (Where the server's clocks agree, the very next answer; on a machine whose wall clock runs
      // ahead of its monotonic clock, Next serves the dropped list once more while it reads afresh.)
      expect((await guest.request.post(`/api/media/${theirs.id}/remove`)).ok()).toBe(true);
      await expect.poll(() => slideIds(request), { timeout: 3_000, intervals: [100] }).toEqual([toHide.id, kept.id, late.id]);

      // The couple's Hide (a server action, updateTag): out of the next answer where the clocks agree;
      // held here to the list's lifetime, which bounds it on any machine.
      const adminPage = await admin.newPage();
      await hideFromAdmin(adminPage, "Selorm Agbeko");
      await expect.poll(() => slideIds(request), { timeout: 20_000, intervals: [250] }).toEqual([kept.id, late.id]);

      // A moment that turns ready later comes in with the list's own lifetime, without a reload.
      const later = await seedMoment(sql, { index: 4, secondsAgo: TEN_MINUTES - 30, uploaderName: "Kwesi Mensah" });
      await expect.poll(() => slideIds(request), { timeout: 45_000, intervals: [2_000] }).toEqual([later.id, kept.id, late.id]);
    } finally {
      await guest.close();
      await admin.close();
    }
  });
});
