import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";
import sharp from "sharp";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "../test/env";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

/*
 * The admin's Site photos (Task 19) against the production build, the test database, MinIO and
 * the media worker's image: what it refuses without Cloudflare Access, replacing the home hero
 * (uploaded straight to storage, made ready by the worker, saved with its alt text and focal point,
 * then on the home page from the media domain), and a link preview card the worker draws.
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

const WHATSAPP = "WhatsApp/2.23.20.0";
const CACHE_NOTE = "Saved. Links shared from now on show the new card; WhatsApp may keep the old one on links already sent.";

/** The couple's browser, signed in through Cloudflare Access. */
async function couple(browser: Browser, baseURL: string | undefined, width = 1280): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width, height: 900 }, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
}

const slotOf = (page: Page, name: string): Locator => page.getByRole("article", { name, exact: true });

/** A landscape photo, 2400 × 1600: blue down its left third, the rest a warm red, with grain. */
async function lakePhoto(): Promise<Buffer> {
  return sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 190, g: 70, b: 50 }, noise: { type: "gaussian", mean: 0, sigma: 12 } } })
    .composite([{ input: { create: { width: 800, height: 1600, channels: 3, background: { r: 30, g: 60, b: 210 } } }, left: 0, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** The link-preview tags a crawler such as WhatsApp's reads: the <head> of the first HTML. */
async function ogImage(request: APIRequestContext, path: string): Promise<string | undefined> {
  const html = await (await request.get(path, { headers: { "user-agent": WHATSAPP } })).text();
  const head = html.slice(0, html.indexOf("</head>"));
  return /<meta property="og:image" content="([^"]*)"/.exec(head)?.[1];
}

async function forgetSitePhotos(): Promise<void> {
  await sql`delete from site_images`;
  await sql`delete from media where purpose = 'site'`;
}

test.beforeEach(forgetSitePhotos);

test.afterAll(async () => {
  await forgetSitePhotos();
  await sql.end();
});

test("without Cloudflare Access the Site photos page shows no slot, and its upload routes refuse", async ({ request }) => {
  const html = await (await request.get("/admin/photos/site")).text();
  expect(html).toContain("This page is for the couple.");
  expect(html).not.toContain("Home hero");
  for (const [method, path] of [
    ["post", "/admin/photos/site/uploads"],
    ["post", "/admin/photos/site/uploads/6f9a3a1e-2c5b-4a8e-9a43-4c1f3b7e0d11/parts"],
    ["post", "/admin/photos/site/uploads/6f9a3a1e-2c5b-4a8e-9a43-4c1f3b7e0d11/complete"],
    ["get", "/admin/photos/site/uploads/6f9a3a1e-2c5b-4a8e-9a43-4c1f3b7e0d11"],
  ] as const) {
    const response = await request[method](path, method === "post" ? { data: { filename: "a.jpg", size: 10, contentType: "image/jpeg" } } : {});
    expect(response.status(), path).toBe(403);
    expect(response.headers()["cache-control"], path).toBe("private, no-store");
  }
  expect((await sql`select count(*)::int as count from media where purpose = 'site'`)[0].count).toBe(0);
});

test.describe("replacing the site's photos", () => {
  test.describe.configure({ timeout: 180_000 });

  test("the home hero, replaced in the admin, shows on the home page from the media domain at its focal point", async ({ browser, baseURL }) => {
    const context = await couple(browser, baseURL);
    const page = await context.newPage();
    await page.goto("/admin/photos/site");
    await expect(page.getByRole("link", { name: "Site photos" })).toHaveAttribute("aria-current", "page");
    const hero = slotOf(page, "Home hero");
    await expect(hero.getByText("No photo yet", { exact: true })).toBeVisible();

    const chooser = page.waitForEvent("filechooser");
    await hero.getByRole("button", { name: "Add a photo for Home hero" }).click();
    await (await chooser).setFiles({ name: "pre-wedding-lake.jpg", mimeType: "image/jpeg", buffer: await lakePhoto() });
    // Sent straight to storage, then made ready by the worker: the editor opens on it, not yet saved.
    const alt = hero.getByLabel("Alt text");
    await expect(alt).toBeVisible({ timeout: 120_000 });
    await expect(hero.getByText("Not saved", { exact: true })).toBeVisible();

    // Save asks for alt text first.
    await hero.getByRole("button", { name: "Save" }).click();
    await expect(hero.getByText("Describe the photo before saving.")).toBeVisible();
    await alt.fill("E2E Noblet and Nancy by the lake");

    // Tap the focal point a fifth across and a quarter down.
    const picker = hero.getByRole("button", { name: /^Focal point/ });
    const box = (await picker.boundingBox())!;
    await picker.click({ position: { x: box.width * 0.2, y: box.height * 0.25 } });
    await expect(picker).toHaveAttribute("aria-label", /20% across and 25% down/);

    await hero.getByRole("button", { name: "Save" }).click();
    await expect(hero.getByText("Saved. The site shows it within a few seconds.")).toBeVisible();
    await expect(hero.getByText("Your photo", { exact: true })).toBeVisible();
    const [row] = await sql`select media_id, alt, focal_x, focal_y from site_images where slot = 'home-hero'`;
    expect(row).toMatchObject({ alt: "E2E Noblet and Nancy by the lake" });
    expect(row.focal_x).toBeCloseTo(0.2, 1);
    expect(row.focal_y).toBeCloseTo(0.25, 1);
    await context.close();

    // A guest's home page: the photo behind the names, from the worker's sizes on the media domain.
    const guest = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await guest.goto("/home");
    const backdrop = guest.locator("#top img[data-site-photo]");
    await expect(backdrop).toHaveCount(1);
    const src = await backdrop.getAttribute("src");
    expect(src?.startsWith(`${TEST_STORAGE_ENV.MEDIA_BASE_URL}/derived/${row.media_id}/`)).toBe(true);
    expect(await backdrop.getAttribute("srcset")).toMatch(/medium\.webp 960w.*large\.webp 2400w/);
    expect(await backdrop.getAttribute("width")).toBe("2400");
    expect(await backdrop.getAttribute("height")).toBe("1600");
    const position = await backdrop.evaluate((image) => getComputedStyle(image).objectPosition);
    const [across, down] = position.split(" ").map((part) => Number.parseFloat(part));
    expect(across).toBeCloseTo(20, -0.5);
    expect(down).toBeCloseTo(25, -0.5);
    // It loads, and never through Next's image optimiser.
    await expect.poll(() => backdrop.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await guest.locator("#top img[src*='/_next/image']").count()).toBe(0);
    await guest.close();
  });

  test("a link preview's photo, refocused in the admin, gets a card the worker draws, and /album's og:image points at it", async ({
    browser,
    baseURL,
    request,
  }) => {
    expect(await ogImage(request, "/album")).toMatch(/\/album\/opengraph-image/);
    const context = await couple(browser, baseURL);
    const page = await context.newPage();
    await page.goto("/admin/photos/site");
    const album = slotOf(page, "Album");
    await album.getByRole("button", { name: "Edit Album" }).click();
    // The card shows with WhatsApp's crop lines.
    await expect(album.getByRole("img", { name: "The link preview card for Album" })).toBeVisible();
    await expect(album.getByText("Between the dashed lines is what WhatsApp shows in a chat.")).toBeVisible();
    const picker = album.getByRole("button", { name: /^Focal point/ });
    const box = (await picker.boundingBox())!;
    await picker.click({ position: { x: box.width * 0.5, y: box.height * 0.8 } });
    await album.getByRole("button", { name: "Save" }).click();
    await expect(album.getByText(CACHE_NOTE).or(album.getByText("Saved. Drawing the new card…"))).toBeVisible();
    await expect(album.getByText(CACHE_NOTE)).toBeVisible({ timeout: 60_000 });
    await context.close();

    const [row] = await sql`select card_key from site_images where slot = 'preview-album'`;
    expect(row.card_key).toMatch(/^derived\/site-preview-album\/[0-9a-f]{16}\/card\.jpg$/);
    await expect.poll(() => ogImage(request, "/album")).toBe(`${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${row.card_key}`);
    const card = await fetch(`${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${row.card_key}`, { signal: AbortSignal.timeout(10_000) });
    expect(card.headers.get("content-type")).toBe("image/jpeg");
    const bytes = Buffer.from(await card.arrayBuffer());
    expect(bytes.length).toBeLessThanOrEqual(80 * 1024);
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 1200, height: 630, format: "jpeg" });
    // Other pages keep their own cards.
    expect(await ogImage(request, "/wishes")).toMatch(/\/wishes\/opengraph-image/);
  });
});
