import { randomBytes, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import sharp from "sharp";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "../test/env";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

/*
 * The admin's Photos page (Task 17) against the production build, the test database, MinIO and the
 * media worker's image: what it refuses without Cloudflare Access, hiding from it (spec §13), the
 * two switches and the wishes.
 */

const sql = postgres({
  host: TEST_DB_ENV.POSTGRES_HOST,
  port: Number(TEST_DB_ENV.POSTGRES_PORT),
  database: TEST_DB_ENV.POSTGRES_DB,
  user: TEST_DB_ENV.POSTGRES_USER,
  password: TEST_DB_ENV.POSTGRES_PASSWORD,
  max: 1,
  connect_timeout: 5,
  onnotice: () => {},
});

const storage = new S3Client({
  endpoint: TEST_STORAGE_ENV.R2_ENDPOINT,
  region: "auto",
  forcePathStyle: true,
  credentials: { accessKeyId: TEST_STORAGE_ENV.R2_ACCESS_KEY_ID, secretAccessKey: TEST_STORAGE_ENV.R2_SECRET_ACCESS_KEY },
});

async function putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  await storage.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

/**
 * A ready photo as the worker leaves it: a real JPEG original in the private bucket (which the
 * worker can process again), and its thumbnail and viewing size in the public one.
 */
async function seedPhoto(uploaderName: string, uploadedAt = new Date()): Promise<{ id: string; thumbUrl: string }> {
  const id = randomUUID();
  const hash = randomBytes(8).toString("hex");
  const thumb = `derived/${id}/${hash}/thumb.webp`;
  const view = `derived/${id}/${hash}/view.webp`;
  const picture = sharp(randomBytes(240 * 180 * 3), { raw: { width: 240, height: 180, channels: 3 } });
  await putObject(TEST_STORAGE_ENV.R2_PUBLIC_BUCKET, thumb, await picture.clone().webp().toBuffer(), "image/webp");
  await putObject(TEST_STORAGE_ENV.R2_PUBLIC_BUCKET, view, await picture.clone().webp().toBuffer(), "image/webp");
  const original = await picture.clone().resize(960, 720).jpeg({ quality: 80 }).toBuffer();
  const originalKey = `originals/${id}.jpg`;
  await putObject(TEST_STORAGE_ENV.R2_PRIVATE_BUCKET, originalKey, original, "image/jpeg");
  const now = uploadedAt;
  await sql`
    insert into media (id, purpose, kind, uploader_name, celebration, original_key, original_filename, size_bytes, content_type,
      status, uploaded_at, listed_at, derived, width, height, thumbhash, average_color)
    values (${id}, 'album', 'photo', ${uploaderName}, 'reception', ${originalKey}, 'IMG_0001.JPG', ${original.length}, 'image/jpeg',
      'ready', ${now}, ${now}, ${sql.json({ thumb, view })}, 960, 720, '1QcSHQRnh493V4dIh4eXh1h4kJUI', '#a08070')`;
  return { id, thumbUrl: `${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${thumb}` };
}

/** The couple's browser, signed in through Cloudflare Access. */
async function couple(browser: Browser, baseURL: string | undefined, width = 1280): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    viewport: { width, height: 900 },
    extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() },
  });
}

async function statusOf(url: string): Promise<number> {
  return (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status;
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Selected item" });
// By role, so only what shows counts: while the page streams in, a copy can sit in a hidden template.
const tileOf = (page: Page, sharer: string) =>
  page.getByRole("list", { name: "Album items" }).getByRole("button", { name: new RegExp(`^(Photo|Video) from ${sharer}`) });

test.beforeEach(async () => {
  await sql`delete from upload_events`;
  await sql`delete from media where purpose = 'album'`;
});

test.afterAll(async () => {
  await sql.end();
  storage.destroy();
});

test("without Cloudflare Access the Photos page shows no items, and its routes refuse", async ({ request }) => {
  const photo = await seedPhoto("E2E Secret Sharer");
  const [wish] = await sql`insert into wishes (signed_as, kind, message) values ('E2E Secret Signer', 'text', 'E2E secret wish') returning id`;
  try {
    for (const path of ["/admin/photos", "/admin/photos?show=hidden", "/admin/photos/wishes"]) {
      const html = await (await request.get(path)).text();
      expect(html, path).toContain("This page is for the couple.");
      expect(html, path).not.toContain("E2E Secret Sharer");
      expect(html, path).not.toContain(photo.id);
      expect(html, path).not.toContain("E2E secret wish");
      expect(html, path).not.toContain("Convert backlog videos");
    }
    for (const path of ["/admin/photos/items", "/admin/photos/wishes/items", `/admin/photos/original/${photo.id}`]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(403);
      expect(response.headers()["location"], path).toBeUndefined();
      expect(response.headers()["cache-control"], path).toBe("private, no-store");
      expect(await response.text(), path).not.toContain("E2E Secret");
    }
    // The same requests with the couple's token get in, so the refusal is Access's doing.
    const signedIn = { [ACCESS_HEADER]: await accessToken() };
    expect(await (await request.get("/admin/photos", { headers: signedIn })).text()).toContain("E2E Secret Sharer");
    expect((await request.get(`/admin/photos/original/${photo.id}`, { headers: signedIn, maxRedirects: 0 })).status()).toBe(302);
  } finally {
    await sql`delete from wishes where id = ${wish.id}`;
  }
});

test.describe("hiding from the admin (spec §13)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("an item hidden from the admin page leaves the album, its thumbnail answers 404 and its download is refused; Unhide brings it back", async ({
    browser,
    baseURL,
    request,
  }) => {
    const photo = await seedPhoto("E2E Hidden Sharer");
    expect(await statusOf(photo.thumbUrl)).toBe(200);
    expect(await (await request.get("/album?mode=before")).text()).toContain(`data-moment="${photo.id}"`);
    expect((await request.get(`/api/media/${photo.id}/download`, { maxRedirects: 0 })).status()).toBe(302);

    const context = await couple(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      await tileOf(page, "E2E Hidden Sharer").click();
      await expect(panel(page).getByRole("heading", { name: "Photo from E2E Hidden Sharer" })).toBeVisible();
      // No confirm: hiding is undone as easily.
      await panel(page).getByRole("button", { name: "Hide from the album" }).click();
      await expect(panel(page).getByText("Hidden. Guests can no longer see it.")).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Undo" })).toBeVisible();
      await expect(tileOf(page, "E2E Hidden Sharer")).toHaveAccessibleName(/^Photo from E2E Hidden Sharer, Hidden,/);

      // Out of the album and its downloads at once; the worker deletes its public files.
      expect(await (await request.get("/album?mode=before")).text()).not.toContain(`data-moment="${photo.id}"`);
      expect((await request.get(`/api/media/${photo.id}/download`, { maxRedirects: 0 })).status()).toBe(404);
      expect((await request.get(`/api/media/${photo.id}/download?variant=original`, { maxRedirects: 0 })).status()).toBe(404);
      await expect.poll(() => statusOf(photo.thumbUrl), { timeout: 60_000 }).toBe(404);

      // The couple still judge it by its original, through their own 15-minute link.
      const original = await context.request.get(`/admin/photos/original/${photo.id}`, { maxRedirects: 0 });
      expect(original.status()).toBe(302);
      expect(new URL(original.headers()["location"]).searchParams.get("X-Amz-Expires")).toBe("900");

      // Unhide: processed again, under new keys, and back in the album.
      await page.reload();
      await tileOf(page, "E2E Hidden Sharer").click();
      await panel(page).getByRole("button", { name: "Unhide" }).click();
      await expect(panel(page).getByText(/^Back in the album/)).toBeVisible();
      await expect
        .poll(async () => (await (await request.get("/album?mode=before")).text()).includes(`data-moment="${photo.id}"`), { timeout: 90_000 })
        .toBe(true);
      const [{ derived }] = await sql`select derived from media where id = ${photo.id}`;
      const newThumb = `${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${(derived as { thumb: string }).thumb}`;
      expect(newThumb).not.toBe(photo.thumbUrl);
      expect(await statusOf(newThumb)).toBe(200);
      expect((await request.get(`/api/media/${photo.id}/download`, { maxRedirects: 0 })).status()).toBe(302);
    } finally {
      await context.close();
    }
  });
});

test.describe("Undo and the delete lock", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Undo after a hide puts the item back; Delete stays greyed until the 30-day lock has passed", async ({ browser, baseURL, request }) => {
    const fresh = await seedPhoto("E2E Undo Sharer");
    const old = await seedPhoto("E2E Old Sharer", new Date(Date.now() - 40 * 24 * 3600 * 1000));
    const context = await couple(browser, baseURL, 390);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      // While a search is on, the chips' numbers say they aren't the search's.
      await page.getByRole("searchbox", { name: "Search by the guest who shared it" }).fill("undo sharer");
      await expect(page.getByText("The numbers count everything shown without the search, not just “undo sharer”.")).toBeVisible();
      await expect(page).toHaveURL(/[?&]q=undo\+sharer/);
      await expect(tileOf(page, "E2E Old Sharer")).toHaveCount(0);
      await tileOf(page, "E2E Undo Sharer").click();
      // Uploaded just now: locked, and says until when.
      const remove = panel(page).getByRole("button", { name: "Delete permanently" });
      await expect(remove).toBeDisabled();
      await expect(panel(page).getByText(/^Can be deleted permanently from \d{1,2} \w+, \d{2}:\d{2}\./)).toBeVisible();

      await panel(page).getByRole("button", { name: "Hide from the album" }).click();
      await expect(panel(page).getByText("Hidden. Guests can no longer see it.")).toBeVisible();
      expect(await (await request.get("/album?mode=before")).text()).not.toContain(`data-moment="${fresh.id}"`);
      await panel(page).getByRole("button", { name: "Undo" }).click();
      await expect(panel(page).getByText("Undone. Back in the album: guests see it again once its thumbnail is made, in a moment.")).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Hide from the album" })).toBeVisible();
      const [row] = await sql`select hidden_at from media where id = ${fresh.id}`;
      expect(row.hidden_at).toBeNull();
      await expect
        .poll(async () => (await (await request.get("/album?mode=before")).text()).includes(`data-moment="${fresh.id}"`), { timeout: 90_000 })
        .toBe(true);

      // Uploaded 40 days ago: past its lock, Delete asks first.
      await panel(page).getByRole("button", { name: "Close" }).click();
      await page.getByRole("searchbox", { name: "Search by the guest who shared it" }).fill("");
      await expect(page.getByText(/^The numbers count everything shown without the search/)).toBeHidden();
      await tileOf(page, "E2E Old Sharer").click();
      await expect(panel(page).getByRole("button", { name: "Delete permanently" })).toBeEnabled();
      await expect(panel(page).getByText("Removes the original and every copy. Uploaded more than 30 days ago, so it's no longer locked.")).toBeVisible();
      await panel(page).getByRole("button", { name: "Delete permanently" }).click();
      await expect(panel(page).getByText(`Delete this photo permanently?`)).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Cancel" })).toBeFocused();
      expect(old.id).toBeTruthy();
    } finally {
      await context.close();
    }
  });
});

test.describe("the switches", () => {
  test.afterEach(async () => {
    // Other specs find uploads open and the backlog converting, as global setup leaves them.
    await sql`insert into settings (key, value) values ('uploads_open', 'true'::jsonb), ('convert_backlog', 'true'::jsonb)
      on conflict (key) do update set value = excluded.value`;
    await sql`delete from settings where key = 'slideshow_delay_seconds'`;
  });

  async function setting(key: string): Promise<unknown> {
    const [row] = await sql`select value from settings where key = ${key}`;
    return row?.value;
  }

  test("Uploads shows its confirm copy, and closes and opens the real switch", async ({ browser, baseURL }) => {
    const context = await couple(browser, baseURL, 390);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      const uploads = page.getByRole("switch", { name: "Uploads" });
      await expect(uploads).toHaveAttribute("aria-checked", "true");
      await uploads.click();
      const card = page.locator('[data-switch="uploads"]').filter({ visible: true });
      await expect(card.getByText("Close uploads?")).toBeVisible();
      await expect(
        card.getByText("Guests see “Sharing has closed” and can't send anything new. Anything already sending gets 24 hours to finish."),
      ).toBeVisible();
      // The switch doesn't move until the confirm.
      await expect(uploads).toHaveAttribute("aria-checked", "true");
      await expect(card.getByRole("button", { name: "Cancel" })).toBeFocused();
      await card.getByRole("button", { name: "Close uploads" }).click();
      await expect(card.getByText("Uploads are closed.")).toBeVisible();
      await expect(uploads).toHaveAttribute("aria-checked", "false");
      expect(await setting("uploads_open")).toBe(false);
      expect(await setting("uploads_closed_at")).toEqual(expect.any(String));

      await uploads.click();
      await expect(card.getByText("Open uploads again?")).toBeVisible();
      await expect(card.getByText("Guests can share straight away.")).toBeVisible();
      await card.getByRole("button", { name: "Open uploads" }).click();
      await expect(card.getByText("Uploads are open.")).toBeVisible();
      await expect(uploads).toHaveAttribute("aria-checked", "true");
      expect(await setting("uploads_open")).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("a switch the other admin flipped since the page loaded asks about what is true now", async ({ browser, baseURL }) => {
    const context = await couple(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      const uploads = page.getByRole("switch", { name: "Uploads" });
      await expect(uploads).toHaveAttribute("aria-checked", "true");
      // Closed elsewhere: this page still shows them open.
      await sql`insert into settings (key, value) values ('uploads_open', 'false'::jsonb)
        on conflict (key) do update set value = excluded.value`;
      await uploads.click();
      const card = page.locator('[data-switch="uploads"]').filter({ visible: true });
      await expect(card.getByText("Open uploads again?")).toBeVisible();
      await expect(uploads).toHaveAttribute("aria-checked", "false");
      await card.getByRole("button", { name: "Cancel" }).click();
      await expect(card.getByText("Open uploads again?")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("the confirm's yes waits until the switch's state is read again, so it can't change under a click", async ({ browser, baseURL }) => {
    const context = await couple(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      await page.waitForLoadState("networkidle");
      // Hold the page's re-read (its RSC request) until the test lets it go.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let reread = false;
      await page.route("**/admin/photos**", async (route) => {
        const headers = route.request().headers();
        if (headers["rsc"] === "1" && !headers["next-router-prefetch"]) {
          reread = true;
          await held;
        }
        await route.continue();
      });
      await page.getByRole("switch", { name: "Uploads" }).click();
      const card = page.locator('[data-switch="uploads"]').filter({ visible: true });
      await expect(card.getByText("Close uploads?")).toBeVisible();
      await expect.poll(() => reread).toBe(true);
      const yes = card.getByRole("button", { name: "Close uploads" });
      await expect(yes).toBeDisabled();
      await expect(card.getByRole("button", { name: "Cancel" })).toBeEnabled();
      release();
      await expect(yes).toBeEnabled();
      await page.unroute("**/admin/photos**");
      await card.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await context.close();
    }
  });

  test("Convert backlog videos shows its hint and confirm copy, and turns the real switch off and on", async ({ browser, baseURL }) => {
    const context = await couple(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      const backlog = page.getByRole("switch", { name: "Convert backlog videos" });
      const card = page.locator('[data-switch="backlog"]').filter({ visible: true });
      await expect(card.getByText("Turn off over the wedding weekend so phones get their videos first.")).toBeVisible();
      await backlog.click();
      await expect(card.getByText("Turn off backlog conversion?")).toBeVisible();
      await expect(card.getByText(/^Videos guests open, and highlights, still convert straight away\./)).toBeVisible();
      // Cancel leaves it as it was.
      await card.getByRole("button", { name: "Cancel" }).click();
      await expect(card.getByText("Turn off backlog conversion?")).toBeHidden();
      expect(await setting("convert_backlog")).toBe(true);

      await backlog.click();
      await card.getByRole("button", { name: "Turn off" }).click();
      await expect(card.getByText("Backlog conversion is off.")).toBeVisible();
      await expect(backlog).toHaveAttribute("aria-checked", "false");
      expect(await setting("convert_backlog")).toBe(false);

      await backlog.click();
      await expect(card.getByText("Turn on backlog conversion?")).toBeVisible();
      await card.getByRole("button", { name: "Turn on" }).click();
      await expect(card.getByText("Backlog conversion is on.")).toBeVisible();
      expect(await setting("convert_backlog")).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("the TV delay saves 0 to 900 seconds, and refuses more", async ({ browser, baseURL }) => {
    const context = await couple(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto("/admin/photos");
      const card = page.locator('[data-switch="tv-delay"]').filter({ visible: true });
      await expect(card.getByText("Default", { exact: true })).toBeVisible();
      await card.getByLabel("Seconds").fill("901");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Use a whole number of seconds from 0 to 900.")).toBeVisible();
      expect(await setting("slideshow_delay_seconds")).toBeUndefined();
      await card.getByLabel("Seconds").fill("60");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Saved. New moments reach the TV after 1 minute.")).toBeVisible();
      expect(await setting("slideshow_delay_seconds")).toBe(60);
      await expect(card.getByText("1 minute", { exact: true })).toBeVisible();

      // Back to the default: the setting goes, and the environment's delay applies again.
      await card.getByRole("button", { name: "Use the default" }).click();
      await expect(card.getByText(/^Back to the default\. New moments reach the TV after 3 minutes\.$/)).toBeVisible();
      await expect(card.getByText("Default", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "Use the default" })).toHaveCount(0);
      await expect(card.getByLabel("Seconds")).toHaveValue("180");
      // The button that had focus is gone: focus is on the seconds, still in the card.
      await expect(card.getByLabel("Seconds")).toBeFocused();
      expect(await setting("slideshow_delay_seconds")).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});

test("a wish hidden from the Wishes tab leaves the wall, and Unhide puts it back", async ({ browser, baseURL, request }) => {
  const message = `E2E wish to hide ${randomUUID().slice(0, 8)}`;
  const [wish] = await sql`insert into wishes (signed_as, kind, message) values ('E2E Wisher', 'text', ${message}) returning id`;
  const context = await couple(browser, baseURL, 390);
  try {
    expect(await (await request.get("/wishes")).text()).toContain(message);
    const page = await context.newPage();
    await page.goto("/admin/photos/wishes");
    const row = page.locator(`[data-wish="${wish.id}"]`);
    await row.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByText("Hidden. E2E Wisher's wish is off the wall.")).toBeVisible();
    await expect(row.getByText("Hidden", { exact: true })).toBeVisible();
    expect(await (await request.get("/wishes")).text()).not.toContain(message);

    await row.getByRole("button", { name: "Unhide" }).click();
    await expect(page.getByText("E2E Wisher's wish is back on the wall.")).toBeVisible();
    expect(await (await request.get("/wishes")).text()).toContain(message);

    await row.getByRole("button", { name: "Delete permanently" }).click();
    await expect(row.getByText("Delete this wish permanently? It can't be undone.")).toBeVisible();
    await row.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText("Deleted permanently.")).toBeVisible();
    await expect(row).toHaveCount(0);
  } finally {
    await context.close();
    await sql`delete from wishes where id = ${wish.id}`;
  }
});
