import { randomBytes, randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import sharp from "sharp";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "../test/env";

/*
 * The album, the viewer and downloads (Task 15), against the production build, the test database
 * and MinIO. Moments are seeded straight into the database with real thumbnails, viewing sizes and
 * originals in MinIO, as the media worker leaves them; the personal link's test (spec §13) sends a
 * real photo through the uploader and the worker.
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

const PALETTE = ["#c9a27e", "#7b3a2c", "#d3d9c8", "#2a1b1f", "#efe5d8", "#c96a3a", "#9aa68b", "#6a4a3e", "#f2e9e1", "#b9805f"];

let fixtures: string;

type Seeded = { id: string; kind: "photo" | "video"; guestId: string | null };

/** A picture of its own colour, as WebP: a stand-in for the worker's thumbnail or viewing size. */
async function webp(width: number, height: number, colour: string): Promise<Buffer> {
  const noise = await sharp({ create: { width: Math.ceil(width / 8), height: Math.ceil(height / 8), channels: 3, background: colour, noise: { type: "gaussian", mean: 128, sigma: 18 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .composite([{ input: await sharp(noise).resize(width, height).png().toBuffer(), blend: "soft-light" }])
    .webp({ quality: 60 })
    .toBuffer();
}

async function putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  await storage.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

/**
 * Seeds a ready moment, listed `secondsAgo` before now, with its files in MinIO. A photo's original
 * is a real JPEG (for its download); a video has a poster, and the versions given.
 */
async function seedMoment(options: {
  index: number;
  secondsAgo: number;
  kind?: "photo" | "video";
  guestId?: string | null;
  celebration?: string;
  status?: "ready" | "uploaded" | "failed";
  failureReason?: string;
  uploaderName?: string;
  videoCodec?: string;
  derived?: Record<string, string>;
}): Promise<Seeded> {
  const id = randomUUID();
  const kind = options.kind ?? "photo";
  const status = options.status ?? "ready";
  const colour = PALETTE[options.index % PALETTE.length];
  const [width, height] = kind === "video" ? [1080, 1920] : options.index % 3 === 0 ? [1600, 1200] : [1200, 1600];
  const hash = randomBytes(8).toString("hex");
  const derived: Record<string, string> = {};
  if (status === "ready") {
    const prefix = kind === "video" ? "poster-" : "";
    derived[`${prefix}thumb`] = `derived/${id}/${hash}/${prefix}thumb.webp`;
    derived[`${prefix}view`] = `derived/${id}/${hash}/${prefix}view.webp`;
    await putObject(TEST_STORAGE_ENV.R2_PUBLIC_BUCKET, derived[`${prefix}thumb`], await webp(Math.round(width * 0.3), Math.round(height * 0.3), colour), "image/webp");
    await putObject(TEST_STORAGE_ENV.R2_PUBLIC_BUCKET, derived[`${prefix}view`], await webp(Math.round(width / 2), Math.round(height / 2), colour), "image/webp");
  }
  const extension = kind === "video" ? "mov" : "jpg";
  const original = `originals/${id}.${extension}`;
  const originalBytes =
    kind === "photo" ? await sharp({ create: { width: 640, height: 480, channels: 3, background: colour } }).jpeg().toBuffer() : randomBytes(2048);
  await putObject(TEST_STORAGE_ENV.R2_PRIVATE_BUCKET, original, originalBytes, kind === "photo" ? "image/jpeg" : "video/quicktime");
  const listed = status === "ready" ? new Date(Date.now() - options.secondsAgo * 1000) : null;
  await sql`
    insert into media (id, purpose, kind, guest_id, uploader_name, celebration, original_key, original_filename, size_bytes,
      content_type, status, failure_reason, uploaded_at, captured_at, listed_at, derived, width, height, duration_seconds,
      thumbhash, average_color, video_codec, browser_playable)
    values (${id}, 'album', ${kind}, ${options.guestId ?? null}, ${options.uploaderName ?? "Kwame"}, ${options.celebration ?? "reception"},
      ${original}, ${`IMG_${options.index}.${extension.toUpperCase()}`}, ${originalBytes.length},
      ${kind === "photo" ? "image/jpeg" : "video/quicktime"}, ${status}, ${options.failureReason ?? null},
      ${new Date(Date.now() - options.secondsAgo * 1000 - 5000)}, ${listed}, ${listed},
      ${sql.json({ ...derived, ...(options.derived ?? {}) })}, ${status === "ready" ? width : null}, ${status === "ready" ? height : null},
      ${kind === "video" ? 27.4 : null}, ${status === "ready" ? "1QcSHQRnh493V4dIh4eXh1h4kJUI" : null}, ${status === "ready" ? colour : null},
      ${kind === "video" ? (options.videoCodec ?? "hevc") : null}, ${kind === "video" ? false : null})`;
  return { id, kind, guestId: options.guestId ?? null };
}

/** `count` ready photos, the newest first in the returned list, listed a few seconds apart, ending `endingSecondsAgo` ago. */
async function seedPhotos(count: number, endingSecondsAgo = 120): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  for (let index = 0; index < count; index += 1) {
    seeded.push(await seedMoment({ index, secondsAgo: endingSecondsAgo + (count - index) * 3 }));
  }
  return seeded.reverse();
}

async function phone(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

/** A guest of the context's own (its cookie set by the guest call, as the uploader's is); returns their id. */
async function guestOf(context: BrowserContext, displayName: string): Promise<string> {
  const response = await context.request.post("/api/guest", { data: { displayName } });
  expect(response.ok()).toBe(true);
  return (await response.json()).guestId;
}

const grid = (page: Page) => page.getByRole("main").getByRole("list", { name: "Moments" });
const tiles = (page: Page) => grid(page).getByRole("listitem");
const viewer = (page: Page) => page.getByRole("dialog", { name: "Moment" });

test.beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "nona-album-e2e-"));
});

test.beforeEach(async () => {
  // The album starts empty for each test (other specs' uploads included); wishes keep theirs.
  await sql`delete from upload_events`;
  await sql`delete from media where purpose = 'album'`;
});

test.afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
  await sql.end();
  storage.destroy();
});

test.describe("the album", () => {
  test.describe.configure({ timeout: 120_000 });

  test("renders its first 30 moments on the server, and the 31st loads as the guest scrolls down", async ({ browser, baseURL }) => {
    const seeded = await seedPhotos(31);
    const context = await phone(browser, baseURL);
    try {
      // The server's own HTML holds the first page, newest first, and the count of them all.
      const html = await (await context.request.get("/album?mode=before")).text();
      const served = [...html.matchAll(/data-moment="([0-9a-f-]{36})"/g)].map((match) => match[1]);
      expect(served).toEqual(seeded.slice(0, 30).map((moment) => moment.id));

      const page = await context.newPage();
      await page.goto("/album?mode=before");
      await expect(page.getByRole("main").getByText("31 moments")).toBeVisible();
      await expect(tiles(page)).toHaveCount(30);
      await tiles(page).last().scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 4000);
      await expect(tiles(page)).toHaveCount(31, { timeout: 15_000 });
      await expect(grid(page).locator(`[data-moment="${seeded[30].id}"]`)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("keeps the first page's HTML under 60 KB as sent, with 30 moments", async ({ baseURL }) => {
    await seedPhotos(30);
    // What a phone receives: the page compressed, as the server (and Cloudflare after it) sends it.
    const sent = await new Promise<{ encoding: string | undefined; bytes: number; html: string }>((resolve, reject) => {
      const request = httpGet(`${baseURL}/album?mode=before`, { headers: { "Accept-Encoding": "gzip" } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const encoding = response.headers["content-encoding"];
          resolve({ encoding, bytes: body.length, html: (encoding === "gzip" ? gunzipSync(body) : body).toString("utf8") });
        });
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    const raw = Buffer.byteLength(sent.html);
    console.log(`[album] first page HTML with 30 moments: ${(sent.bytes / 1024).toFixed(1)} KB sent (${sent.encoding}), ${(raw / 1024).toFixed(1)} KB uncompressed`);
    expect(sent.encoding).toBe("gzip");
    expect([...sent.html.matchAll(/data-moment="/g)]).toHaveLength(30);
    expect(sent.bytes).toBeLessThan(60 * 1024);
    // The page before Task 15 was 116 KB uncompressed with 15 sample moments: no growing back past it.
    expect(raw).toBeLessThan(100 * 1024);
  });

  test("a moment opens in the viewer at #m/<id>; the arrow keys move along, and Back closes it", async ({ browser, baseURL }) => {
    const seeded = await seedPhotos(4);
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto("/album?mode=before");
      await grid(page).locator(`[data-moment="${seeded[1].id}"] button`).click();

      await expect(viewer(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#m/${seeded[1].id}$`));
      await expect(viewer(page).getByText("Shared by Kwame")).toBeVisible();
      await expect(viewer(page).getByText(/Reception · /)).toBeVisible();

      await page.keyboard.press("ArrowRight");
      await expect(page).toHaveURL(new RegExp(`#m/${seeded[2].id}$`));

      // A mark on this very page: a reload would lose it.
      await page.evaluate(() => ((window as unknown as { samePage: boolean }).samePage = true));
      await page.goBack();
      await expect(viewer(page)).toBeHidden();
      await expect(page).toHaveURL(/\/album\?mode=before$/);
      // Still the same page: the album wasn't loaded again.
      expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBe(true);
      await expect(tiles(page)).toHaveCount(4);
    } finally {
      await context.close();
    }
  });

  test("a moment's own link opens it in the viewer for anyone, and × closes it", async ({ browser, baseURL }) => {
    const [newest, older] = await seedPhotos(2);
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto(`/album?mode=before#m/${older.id}`);
      await expect(viewer(page)).toBeVisible();
      await expect(viewer(page).getByText(/^Moment\s*2\s*\/\s*of\s*2$/)).toBeVisible();
      await viewer(page).getByRole("button", { name: "Close" }).click();
      await expect(viewer(page)).toBeHidden();
      await expect(page).not.toHaveURL(/#m\//);
      expect(newest.id).not.toBe(older.id);
    } finally {
      await context.close();
    }
  });

  test("Download offers the original photo, which arrives named NONA26-<celebration>-<short id>.jpg", async ({ browser, baseURL }) => {
    const [moment] = await seedPhotos(1);
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    try {
      const page = await context.newPage();
      await page.goto(`/album?mode=before#m/${moment.id}`);
      await viewer(page).getByRole("button", { name: "Download" }).click();
      const menu = viewer(page).getByRole("menu", { name: "Download" });
      await expect(menu.getByRole("menuitem", { name: /Original photo/ })).toBeVisible();
      const [download] = await Promise.all([page.waitForEvent("download"), menu.getByRole("menuitem", { name: /Original photo/ }).click()]);
      expect(download.suggestedFilename()).toBe(`NONA26-reception-${moment.id.slice(0, 8)}.jpg`);
    } finally {
      await context.close();
    }
  });

  test("a video this phone can't play yet shows its poster and says a version is being prepared", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const guestId = await guestOf(context, "E2E Viewer");
      const video = await seedMoment({ index: 4, secondsAgo: 60, kind: "video", videoCodec: "hevc", uploaderName: "Yaw" });
      const page = await context.newPage();
      await page.goto(`/album?mode=before#m/${video.id}`);
      await expect(viewer(page).getByText("Preparing a version for your phone…")).toBeVisible();
      await expect(viewer(page).getByText("It takes a minute or two, and plays here when it's ready.")).toBeVisible();
      await expect(viewer(page).getByText("You can save it once your phone's version is ready.").or(viewer(page).getByRole("button", { name: "Download" }))).toBeVisible();
      // The phone asked for its conversion, on demand.
      await expect.poll(async () => (await sql`select conversion_requested_at from media where id = ${video.id}`)[0].conversion_requested_at, { timeout: 15_000 }).not.toBeNull();
      expect(guestId).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  test("Remove my upload shows only on the guest's own moment, asks first, and takes it out of the album", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const guestId = await guestOf(context, "Ama Owusu");
      const theirs = await seedMoment({ index: 1, secondsAgo: 300 });
      const own = await seedMoment({ index: 2, secondsAgo: 200, guestId, uploaderName: "Ama Owusu" });
      const page = await context.newPage();

      await page.goto(`/album?mode=before#m/${theirs.id}`);
      await expect(viewer(page).getByText("Shared by Kwame")).toBeVisible();
      await expect(viewer(page).getByRole("button", { name: "Remove my upload" })).toBeHidden();

      await page.goto(`/album?mode=before#m/${own.id}`);
      await expect(viewer(page).getByText("Shared by you")).toBeVisible();
      await viewer(page).getByRole("button", { name: "Remove my upload" }).click();
      const confirm = page.getByRole("alertdialog", { name: "Remove this from the album?" });
      await expect(confirm.getByText("Everyone will stop seeing it.")).toBeVisible();
      await expect(confirm.getByRole("button", { name: "Keep it" })).toBeFocused();
      await confirm.getByRole("button", { name: "Remove it" }).click();

      await expect(viewer(page).getByText("Shared by Kwame")).toBeVisible();
      await expect(grid(page).locator(`[data-moment="${own.id}"]`)).toHaveCount(0);
      const [row] = await sql`select removed_by_uploader, hidden_at from media where id = ${own.id}`;
      expect(row.removed_by_uploader).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("My uploads shows the guest's own moments, waiting and failed ones with their reason, and Videos with none says so", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const guestId = await guestOf(context, "Ama Owusu");
      await seedMoment({ index: 1, secondsAgo: 400 });
      const own = await seedMoment({ index: 2, secondsAgo: 300, guestId });
      await seedMoment({ index: 3, secondsAgo: 0, guestId, status: "failed", failureReason: "too-large" });
      await seedMoment({ index: 4, secondsAgo: 0, guestId, status: "uploaded" });
      const page = await context.newPage();
      await page.goto("/album?mode=before&view=mine");

      await expect(page.getByRole("main").getByRole("group", { name: "Whose moments" }).getByRole("button", { name: "My uploads" })).toHaveAttribute("aria-pressed", "true");
      await expect(tiles(page)).toHaveCount(3);
      await expect(grid(page).getByText("This photo is too large to show")).toBeVisible();
      await expect(grid(page).getByText("Getting it ready")).toBeVisible();
      await expect(grid(page).locator(`[data-moment="${own.id}"]`)).toBeVisible();

      await page.getByRole("main").getByRole("button", { name: "Videos only" }).click();
      await expect(page.getByRole("main").getByText("No videos from you yet. Tap Record video above to add one.")).toBeVisible();
      await expect(page.getByRole("main").getByText("0 videos")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("new moments wait in a pill rather than shuffle the grid; tapping it brings them in", async ({ browser, baseURL }) => {
    await seedPhotos(6);
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.clock.install();
      await page.goto("/album?mode=before");
      await expect(tiles(page)).toHaveCount(6);

      const fresh = await seedMoment({ index: 9, secondsAgo: 0, uploaderName: "Selorm" });
      await page.clock.fastForward(31_000);
      const pill = page.getByRole("button", { name: "Show 1 new moment" });
      await expect(pill).toBeVisible({ timeout: 15_000 });
      await expect(tiles(page)).toHaveCount(6);

      await pill.click();
      await expect(tiles(page)).toHaveCount(7);
      await expect(tiles(page).first()).toHaveAttribute("data-moment", fresh.id);
    } finally {
      await context.close();
    }
  });

  test("the slideshow sits under the share buttons, and the album's old links below the grid are gone", async ({ browser, baseURL }) => {
    await seedPhotos(2);
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await page.goto("/album?mode=before");
      const slideshow = page.getByRole("link", { name: /Watch the slideshow/ });
      await expect(slideshow).toBeVisible();
      await expect(slideshow).toHaveAttribute("href", "/slideshow");
      await expect(page.getByRole("link", { name: "Wishes wall" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Download all/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("a guest's personal link (spec §13)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a second phone opens the first one's link, says \"Yes, that's me\", and sees its moments under My uploads", async ({ browser, baseURL }) => {
    const firstPhone = await phone(browser, baseURL);
    const secondPhone = await phone(browser, baseURL);
    try {
      const page = await firstPhone.newPage();
      await page.goto("/album?mode=before");
      await expect(page.getByRole("main").getByText("Choose photos & videos")).toBeVisible();
      const photo = join(fixtures, "linked.jpg");
      await sharp(randomBytes(900 * 600 * 3), { raw: { width: 900, height: 600, channels: 3 } }).jpeg({ quality: 80 }).toFile(photo);
      await page.getByRole("main").getByLabel("Take a photo").setInputFiles(photo);
      await expect(page.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });

      const [cookie] = (await firstPhone.cookies()).filter((stored) => stored.name === "__Host-nona_guest");
      const guestId = decodeURIComponent(cookie.value).split(".")[0].split(",")[0];
      const [{ link_token: token }] = await sql`select link_token from guests where id = ${guestId}`;
      const [{ id: mediaId }] = await sql`select id from media where guest_id = ${guestId}`;
      await expect.poll(async () => (await sql`select status from media where id = ${mediaId}`)[0].status, { timeout: 60_000 }).toBe("ready");

      const other = await secondPhone.newPage();
      await other.goto(`/my/${token}`);
      await other.getByRole("button", { name: "Yes, that's me" }).click();
      await expect(other).toHaveURL(/\/album\?view=mine$/);
      await expect(other.getByRole("main").getByRole("group", { name: "Whose moments" }).getByRole("button", { name: "My uploads" })).toHaveAttribute("aria-pressed", "true");
      await expect(grid(other).locator(`[data-moment="${mediaId}"]`)).toBeVisible();
      await expect(grid(other).locator(`[data-moment="${mediaId}"]`).getByRole("img", { name: "Your upload" })).toBeVisible();
    } finally {
      await firstPhone.close();
      await secondPhone.close();
    }
  });
});
