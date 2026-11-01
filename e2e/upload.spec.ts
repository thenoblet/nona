import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import postgres from "postgres";
import sharp from "sharp";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "../test/env";

/*
 * Uploading from the phone (Task 13), against the production build, MinIO and the media worker
 * (started by e2e/global-setup.ts). Every file is picked from disk, as a phone's picker hands it
 * over. Uploads are open (the global setup opens them); a test that closes them opens them again.
 */

const MEBIBYTE = 1024 * 1024;
const PART_SIZE = 8 * MEBIBYTE;
const CLOSED_MESSAGE = "Uploads to the album have closed. Thank you for every photo and video you shared!";

let fixtures: string;

function testDb() {
  return postgres({
    host: TEST_DB_ENV.POSTGRES_HOST,
    port: Number(TEST_DB_ENV.POSTGRES_PORT),
    database: TEST_DB_ENV.POSTGRES_DB,
    user: TEST_DB_ENV.POSTGRES_USER,
    password: TEST_DB_ENV.POSTGRES_PASSWORD,
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
}

const sql = testDb();

async function saveSetting(key: string, value: unknown): Promise<void> {
  await sql`
    insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** A photo of its own (random pixels, so no two share a fingerprint), as a JPEG on disk. */
async function photoOnDisk(name: string, width = 900, height = 600): Promise<string> {
  const path = join(fixtures, name);
  await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toFile(path);
  return path;
}

/** A file of random bytes on disk (a stand-in video: the upload never reads inside it). */
async function bytesOnDisk(name: string, size: number): Promise<string> {
  const path = join(fixtures, name);
  await writeFile(path, randomBytes(size));
  return path;
}

/** A file of `size` bytes that takes no space on disk (sparse): a video too long for the album. */
async function sparseOnDisk(name: string, size: number): Promise<string> {
  const path = join(fixtures, name);
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return path;
}

/** A phone: touch, a phone-sized screen, and a guest of its own once it uploads. */
async function phone(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

/** The album with the gallery first (the share buttons outside the wedding weekend), ready to pick. */
async function openAlbum(page: Page): Promise<void> {
  // Notes, in the page, whether "Added" was ever on screen, however briefly.
  await page.addInitScript(() => {
    const seen = window as unknown as { addedSeen: boolean };
    seen.addedSeen = false;
    new MutationObserver(() => {
      if (document.body?.innerText.includes("Added")) seen.addedSeen = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto("/album?mode=before");
  await expect(inMain(page).getByText("Choose photos & videos")).toBeVisible();
}

/**
 * The page's own content. React reveals a streamed Suspense boundary a moment after it arrives, and
 * until then it waits, hidden, outside <main>: a check of the page's words looks inside <main>.
 */
const inMain = (page: Page) => page.getByRole("main");

/** A share button's file input, in <main>: the one React has revealed and hydrated. */
const picker = (page: Page, name: string) => inMain(page).getByLabel(name);

/** Reloads, and waits until the share buttons are revealed and working again. */
async function reloadAlbum(page: Page): Promise<void> {
  await page.reload();
  await expect(inMain(page).getByText("Choose photos & videos")).toBeVisible();
}

const addedSeen = (page: Page) => page.evaluate(() => (window as unknown as { addedSeen: boolean }).addedSeen);

/** Every part PUT, by part number: sent on to storage, answered by it, or dropped on the way. */
type PartPuts = { sent: number[]; finished: number[]; dropped: number[]; held: Route[] };

const partNumberOf = (url: string) => Number(new URL(url).searchParams.get("partNumber"));
const isPartPut = (url: string, method: string) => method === "PUT" && /\/nona-private\/originals\//.test(url);
const ascending = (numbers: number[]) => [...numbers].sort((first, second) => first - second);

/**
 * Watches the part PUTs to MinIO. `decide` says what the network does with each: let it through,
 * drop it (a connection reset, as on mobile data) or hold it (never answered).
 */
async function watchPartPuts(
  page: Page,
  decide: (partNumber: number, attempt: number) => "send" | "drop" | "hold" = () => "send",
): Promise<PartPuts> {
  const puts: PartPuts = { sent: [], finished: [], dropped: [], held: [] };
  const attempts = new Map<number, number>();
  page.on("requestfinished", (request) => {
    if (isPartPut(request.url(), request.method())) puts.finished.push(partNumberOf(request.url()));
  });
  await page.route(/\/nona-private\/originals\//, async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.continue();
    const partNumber = partNumberOf(request.url());
    const attempt = (attempts.get(partNumber) ?? 0) + 1;
    attempts.set(partNumber, attempt);
    const decision = decide(partNumber, attempt);
    if (decision === "drop") {
      puts.dropped.push(partNumber);
      return route.abort("connectionreset");
    }
    if (decision === "hold") {
      puts.held.push(route);
      return;
    }
    puts.sent.push(partNumber);
    return route.continue();
  });
  return puts;
}

/** The phone's own guest id, from the cookie the uploader's guest call set. */
async function ownGuestId(context: BrowserContext): Promise<string> {
  const [cookie] = (await context.cookies()).filter((stored) => stored.name === "__Host-nona_guest");
  return decodeURIComponent(cookie.value).split(".")[0].split(",")[0];
}

async function mediaOf(guestId: string) {
  return sql<{ id: string; status: string; size_bytes: number; file_fingerprint: string; hidden_at: Date | null; removed_by_uploader: boolean; derived: Record<string, string> }[]>`
    select id, status, size_bytes, file_fingerprint, hidden_at, removed_by_uploader, derived
    from media where guest_id = ${guestId} order by started_at`;
}

test.beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "nona-upload-e2e-"));
  await mkdir(fixtures, { recursive: true });
});

test.afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
  await sql.end();
});

test.afterEach(async () => {
  await saveSetting("uploads_open", true);
  await saveSetting("uploads_closed_at", null);
});

test.describe("uploading from the phone", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a photo from the camera is added to the album, and the worker makes it ready", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("camera.jpg"));

      const card = page.getByRole("region", { name: "Your photo" });
      await expect(card.getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      await expect(card.getByText("Everyone will see it shortly")).toBeVisible();
      await expect(card.getByRole("button", { name: "Take another" })).toBeVisible();

      const [item] = await mediaOf(await ownGuestId(context));
      // The worker turns it into the album's own files; the album shows its thumbnail from there.
      await expect.poll(async () => (await mediaOf(await ownGuestId(context)))[0].status, { timeout: 60_000 }).toBe("ready");
      const [ready] = await mediaOf(await ownGuestId(context));
      expect(ready.id).toBe(item.id);
      const thumbnail = await fetch(`${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${ready.derived.thumb}`, { signal: AbortSignal.timeout(10_000) });
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/webp");
    } finally {
      await context.close();
    }
  });

  test("Review Focus 1: a part whose connection drops is sent again, only that part, and the upload completes", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const puts = await watchPartPuts(page, (partNumber, attempt) => (partNumber === 2 && attempt === 1 ? "drop" : "send"));
      const video = await bytesOnDisk("dance.mp4", 30 * MEBIBYTE);

      await picker(page, "Record video").setInputFiles(video);

      const card = page.getByRole("region", { name: "Your video" });
      await expect(card.getByText("Added to the album")).toBeVisible({ timeout: 90_000 });
      await expect(card.getByRole("button", { name: "Record another" })).toBeVisible();
      const partCount = Math.ceil((30 * MEBIBYTE) / PART_SIZE);
      expect(puts.dropped).toEqual([2]);
      expect(ascending(puts.sent)).toEqual([1, 2, 3, 4]);
      expect(puts.sent.length + puts.dropped.length).toBe(partCount + 1);

      const [item] = await mediaOf(await ownGuestId(context));
      expect(item.status).not.toBe("uploading");
      // The phone told the status page about the retry.
      await expect
        .poll(async () => sql`select kind, reason, detail from upload_events where media_id = ${item.id} and kind = 'part-retry'`, {
          timeout: 20_000,
        })
        .toEqual([expect.objectContaining({ kind: "part-retry", reason: "network-error", detail: expect.objectContaining({ partNumber: 2 }) })]);
    } finally {
      await context.close();
    }
  });

  test("Review Focus 1: reloaded mid-upload, the same file re-picked under another name finishes without sending a part twice", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const video = await bytesOnDisk("IMG_0420.MOV", 30 * MEBIBYTE);
      const renamed = join(fixtures, "IMG_0420 copy.MOV");
      await copyFile(video, renamed);

      // Before the reload: part 2's first try drops; parts 3 and 4 never get an answer.
      let reloaded = false;
      const puts = await watchPartPuts(page, (partNumber, attempt) => {
        if (reloaded) return "send";
        if (partNumber === 2 && attempt === 1) return "drop";
        return partNumber >= 3 ? "hold" : "send";
      });
      await picker(page, "Record video").setInputFiles(video);
      // Storage has parts 1 and 2 (part 2 on its second try) before the page goes.
      await expect.poll(() => ascending(puts.finished), { timeout: 30_000 }).toEqual([1, 2]);
      expect(await addedSeen(page)).toBe(false);

      reloaded = true;
      await page.reload();
      await Promise.all(puts.held.splice(0).map((route) => route.abort().catch(() => {})));
      await expect(inMain(page).getByText("Choose photos & videos")).toBeVisible();

      // The complete is held until the test has looked: nothing may say Added before its answer.
      let releaseComplete: () => void = () => {};
      const completeHeld = new Promise<void>((resolve) => {
        releaseComplete = resolve;
      });
      let completeAnswered = false;
      await page.route(/\/api\/uploads\/[^/]+\/complete$/, async (route) => {
        const response = await route.fetch();
        completeAnswered = true;
        await completeHeld;
        await route.fulfill({ response });
      });

      await picker(page, "Record video").setInputFiles(renamed);
      const card = page.getByRole("region", { name: "Your video" });
      await expect(card.getByText("Checking it arrived safely")).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => completeAnswered, { timeout: 30_000 }).toBe(true);
      expect(await addedSeen(page)).toBe(false);
      await expect(card.getByText("100%")).toBeVisible();
      releaseComplete();
      await expect(card.getByText("Added to the album")).toBeVisible({ timeout: 30_000 });

      // Parts 1 and 2 went once each (plus part 2's dropped try); 3 and 4 only after the reload.
      const partCount = Math.ceil((30 * MEBIBYTE) / PART_SIZE);
      expect(puts.dropped).toEqual([2]);
      expect(ascending(puts.sent)).toEqual([1, 2, 3, 4]);
      expect(puts.sent.length + puts.dropped.length).toBe(partCount + 1);
      expect(puts.sent.slice(2)).toEqual(expect.arrayContaining([3, 4]));
      const rows = await mediaOf(await ownGuestId(context));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).not.toBe("uploading");
    } finally {
      await context.close();
    }
  });

  test("a new phone that picks three files at once becomes one guest", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const [{ count: guestsBefore }] = await sql<{ count: number }[]>`select count(*)::int as count from guests`;
      const files = await Promise.all(["one.jpg", "two.jpg", "three.jpg"].map((name) => photoOnDisk(name, 500, 400)));

      await picker(page, "Choose photos & videos").setInputFiles(files);

      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(batch.getByText("3 of 3 sent")).toBeVisible({ timeout: 60_000 });
      await expect(batch.getByText("Added to the album")).toBeVisible();
      const [{ count: guestsAfter }] = await sql<{ count: number }[]>`select count(*)::int as count from guests`;
      expect(guestsAfter - guestsBefore).toBe(1);
      expect(await mediaOf(await ownGuestId(context))).toHaveLength(3);
    } finally {
      await context.close();
    }
  });

  test("a gallery batch shows each file's own state, and a file over 2 GB is turned away before it sends", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const starts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads") starts.push(request.url());
      });
      const photo = await photoOnDisk("fine.jpg", 400, 300);
      const longVideo = await sparseOnDisk("speeches.mp4", 2 * 1024 * MEBIBYTE + 1);

      await picker(page, "Choose photos & videos").setInputFiles([photo, longVideo]);

      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(batch.getByText("This file is over 2 GB", { exact: true })).toBeVisible();
      await expect(batch.getByText("Trim it in your gallery, then choose it again.", { exact: true })).toBeVisible();
      await expect(batch.getByText("1 of 2 sent")).toBeVisible({ timeout: 60_000 });
      await expect(batch.getByText("Added to the album")).toBeVisible();
      await expect(batch.getByRole("button", { name: "Try again" })).toHaveCount(0);
      // Only the photo ever started.
      expect(starts).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("a complete that answers failed shows the failure, never Added", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      await page.route(/\/api\/uploads\/[^/]+\/complete$/, async (route) => {
        const mediaId = new URL(route.request().url()).pathname.split("/")[3];
        await route.fulfill({ json: { mediaId, status: "failed", reason: "corrupt" } });
      });

      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("unreadable.jpg", 300, 200));

      const card = page.getByRole("region", { name: "Your photo" });
      await expect(card.getByText("We couldn't read this file")).toBeVisible({ timeout: 60_000 });
      expect(await addedSeen(page)).toBe(false);
      await page.waitForTimeout(1_000);
      expect(await addedSeen(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("a file whose complete answer was lost, picked again, is added without being sent twice", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const photo = await photoOnDisk("lost-answer.jpg", 600, 400);
      // The complete reaches the server, which finishes the upload; its answer never reaches the phone.
      let completed = false;
      await page.route(/\/api\/uploads\/[^/]+\/complete$/, async (route) => {
        await route.fetch();
        completed = true;
        await route.abort("connectionreset");
      });
      await picker(page, "Take a photo").setInputFiles(photo);
      await expect.poll(() => completed, { timeout: 60_000 }).toBe(true);
      expect(await addedSeen(page)).toBe(false);

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await reloadAlbum(page);
      const starts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads") starts.push(request.url());
      });
      const puts = await watchPartPuts(page);

      await picker(page, "Take a photo").setInputFiles(photo);

      await expect(page.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      expect(puts.sent).toEqual([]);
      expect(starts).toEqual([]);
      expect(await mediaOf(await ownGuestId(context))).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("Cancel, once the server has the file, removes the upload from the album", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      let releaseComplete: () => void = () => {};
      const completeHeld = new Promise<void>((resolve) => {
        releaseComplete = resolve;
      });
      let completeAnswered = false;
      await page.route(/\/api\/uploads\/[^/]+\/complete$/, async (route) => {
        const response = await route.fetch();
        completeAnswered = true;
        await completeHeld;
        await route.fulfill({ response }).catch(() => {});
      });

      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("oops.jpg", 400, 300));
      const card = page.getByRole("region", { name: "Your photo" });
      await expect(card.getByText("Checking it arrived safely")).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => completeAnswered, { timeout: 30_000 }).toBe(true);

      const cancelled = page.waitForResponse((response) => response.request().method() === "DELETE" && /\/api\/uploads\//.test(response.url()));
      const removed = page.waitForResponse((response) => /\/api\/media\/[^/]+\/remove$/.test(response.url()));
      await card.getByRole("button", { name: "Cancel" }).click();
      expect((await cancelled).status()).toBe(409);
      expect((await removed).status()).toBe(200);
      await expect(card).toHaveCount(0);
      releaseComplete();

      const [item] = await mediaOf(await ownGuestId(context));
      expect(item.removed_by_uploader).toBe(true);
      expect(item.hidden_at).not.toBeNull();
      expect(await addedSeen(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("the personal link is offered under the first upload: copy it, or hide it for good", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = await context.newPage();
      await openAlbum(page);

      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("first.jpg", 300, 200));
      const offer = page.getByRole("region", { name: "Your personal link" });
      await expect(offer).toBeVisible({ timeout: 60_000 });
      await expect(offer.getByText("Save this to find your uploads on any phone.")).toBeVisible();
      const [{ link_token: token }] = await sql`select link_token from guests where id = ${await ownGuestId(context)}`;
      await expect(offer.getByText(`/my/${token}`)).toBeVisible();
      // Without Web Share (this browser), Copy link is the only button.
      await expect(offer.getByRole("button", { name: "Share" })).toHaveCount(0);
      await offer.getByRole("button", { name: "Copy link" }).click();
      await expect(offer.getByText("Copied")).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/my/${token}$`));

      await offer.getByRole("button", { name: "Hide this" }).click();
      await expect(offer).toHaveCount(0);
      // Focus goes back to the card above.
      await expect(page.getByRole("region", { name: "Your photo" })).toBeFocused();
      await reloadAlbum(page);
      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("second.jpg", 300, 200));
      await expect(page.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("region", { name: "Your personal link" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("an offer whose script can't be fetched (the venue's network, or a deploy) is left out: the album and the upload carry on", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      // The chunk that draws the offer fails to arrive; every other script comes as usual.
      let offerChunkRefused = false;
      await page.route(/\/_next\/static\/chunks\/.*\.js$/, async (route) => {
        const response = await route.fetch();
        if ((await response.text()).includes("Save this to find your uploads on any phone.")) {
          offerChunkRefused = true;
          return route.abort("failed");
        }
        return route.fulfill({ response });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openAlbum(page);

      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("no-offer.jpg", 300, 200));
      const card = page.getByRole("region", { name: "Your photo" });
      await expect(card.getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => offerChunkRefused, { timeout: 15_000 }).toBe(true);
      await expect(page.getByRole("region", { name: "Your personal link" })).toHaveCount(0);
      await expect(page.getByText(/Application error/)).toHaveCount(0);
      await expect(inMain(page).getByText("Capture it with us")).toBeVisible();

      // The page still works: another photo goes up.
      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("still-works.jpg", 300, 200));
      await expect(page.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the personal link is offered once: a later visit's upload doesn't offer it again", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("once.jpg", 300, 200));
      await expect(page.getByRole("region", { name: "Your personal link" })).toBeVisible({ timeout: 60_000 });

      await reloadAlbum(page);
      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("twice.jpg", 300, 200));
      await expect(page.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(500);
      await expect(page.getByRole("region", { name: "Your personal link" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a file the guest removed, picked again, is sent afresh; one the couple hid is never added again", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const removed = await photoOnDisk("changed-my-mind.jpg", 300, 200);
      // A different size, so the two are told apart by it.
      const hidden = await photoOnDisk("hidden-by-the-couple.jpg", 340, 220);
      await picker(page, "Choose photos & videos").setInputFiles([removed, hidden]);
      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(batch.getByText("2 of 2 sent")).toBeVisible({ timeout: 60_000 });
      const guestId = await ownGuestId(context);
      // Which row is which file: the uploader starts the smaller file first, not the first picked.
      const [removedSize, hiddenSize] = await Promise.all([removed, hidden].map(async (path) => (await stat(path)).size));
      expect(removedSize).not.toBe(hiddenSize);
      const sent = await mediaOf(guestId);
      const first = sent.find((row) => Number(row.size_bytes) === removedSize)!;
      const second = sent.find((row) => Number(row.size_bytes) === hiddenSize)!;
      // The guest removes the first; the couple hide the second.
      expect((await page.request.post(`/api/media/${first.id}/remove`)).status()).toBe(200);
      await sql`update media set hidden_at = now(), hidden_by = 'couple' where id = ${second.id}`;

      await reloadAlbum(page);
      await picker(page, "Choose photos & videos").setInputFiles([removed, hidden]);
      await expect(batch.getByText("1 of 2 sent")).toBeVisible({ timeout: 60_000 });
      await expect(batch.getByText("This one can't be added to the album", { exact: true })).toBeVisible();
      await expect(batch.getByRole("button", { name: "Try again" })).toHaveCount(0);
      const rows = await mediaOf(guestId);
      // The removed one went up again as a new upload; the hidden one stayed as it was.
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.hidden_at === null)).toHaveLength(1);

      // Ruling AX: another phone, which never sent it, can't add the hidden file either.
      const otherPhone = await phone(browser, baseURL);
      try {
        const otherPage = await otherPhone.newPage();
        await openAlbum(otherPage);
        await picker(otherPage, "Take a photo").setInputFiles(hidden);
        await expect(otherPage.getByRole("region", { name: "Your photo" }).getByText("This one can't be added to the album")).toBeVisible({ timeout: 60_000 });
        expect(await mediaOf(await ownGuestId(otherPhone))).toEqual([]);
      } finally {
        await otherPhone.close();
      }
    } finally {
      await context.close();
    }
  });

  test("a failed row can be dismissed, and focus moves to the next row", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      // Visible only: until the streamed album swaps in, a hidden copy of the picker can sit beside it.
      await page
        .getByLabel("Choose photos & videos")
        .filter({ visible: true })
        .setInputFiles([await sparseOnDisk("too-long.mp4", 2 * 1024 * MEBIBYTE + 1), await sparseOnDisk("also-too-long.mp4", 2 * 1024 * MEBIBYTE + 1)]);
      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(batch.getByText("This file is over 2 GB", { exact: true })).toHaveCount(2);

      await batch.getByRole("button", { name: "Dismiss video 1" }).click();
      await expect(batch.getByText("This file is over 2 GB", { exact: true })).toHaveCount(1);
      await expect(batch.getByRole("button", { name: "Dismiss video 1" })).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test("the album shows no placeholder in brackets to a guest who hasn't given a name", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      await expect(inMain(page).getByText("Sharing as a guest")).toBeVisible();
      await inMain(page).getByRole("button", { name: "Add your name" }).click();
      await inMain(page).getByLabel("Your name").fill("Ama");
      await inMain(page).getByRole("button", { name: "Save" }).click();
      await expect(inMain(page).getByText("Sharing as Ama")).toBeVisible();
      expect(await inMain(page).innerText()).not.toMatch(/\[[^\]]*\]/);
    } finally {
      await context.close();
    }
  });
});

test.describe("what a real phone taught the uploader (Task 14b)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Ruling BC: a finished batch tidies itself away, and the personal link stays", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      await picker(page, "Choose photos & videos").setInputFiles([await photoOnDisk("tidy-1.jpg", 300, 200), await photoOnDisk("tidy-2.jpg", 300, 200)]);

      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(batch.getByText("2 of 2 sent")).toBeVisible({ timeout: 60_000 });
      await expect(batch.getByText("Added to the album")).toBeVisible();
      // About 5 s later it fades and goes; the offer of the personal link stays until hidden.
      await expect(batch).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByRole("region", { name: "Your personal link" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("Ruling BB: a photo the phone can't preview shows a photo icon in its place", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      // Chromium, like Chrome on Android, can't draw a HEIC.
      await picker(page, "Choose photos & videos").setInputFiles(await bytesOnDisk("IMG_4021.HEIC", 300_000));

      const row = page.getByRole("region", { name: "Your photos and videos" }).getByRole("listitem", { name: "Photo 1" });
      await expect(row.locator('[data-thumb="icon"]')).toBeVisible({ timeout: 15_000 });
      await expect(row.locator('[data-thumb="icon"] svg')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("Ruling BA: a photo that changed after it was chosen says so, and Choose again opens the picker; chosen again, it goes up", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      // The File the picker handed over goes stale, as one WhatsApp finishes after the pick does:
      // every read of it fails as Chrome's do. The same photo picked again is a fresh File, and reads.
      await page.addInitScript(() => {
        const stale = new WeakSet<Blob>();
        const goingStale = new Set(["IMG-20261205-WA0007.jpg"]);
        const slice = Blob.prototype.slice;
        Blob.prototype.slice = function (this: Blob, ...args: Parameters<Blob["slice"]>) {
          const name = this instanceof File ? this.name : "";
          if (goingStale.delete(name)) stale.add(this);
          const part = slice.apply(this, args);
          if (stale.has(this)) {
            part.arrayBuffer = () =>
              Promise.reject(
                new DOMException(
                  "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
                  "NotReadableError",
                ),
              );
          }
          return part;
        };
      });
      await openAlbum(page);
      const photo = await photoOnDisk("IMG-20261205-WA0007.jpg", 400, 300);
      await picker(page, "Choose photos & videos").setInputFiles(photo);

      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(batch.getByText("This photo changed after you chose it", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(batch.getByText("Choose it again.", { exact: true })).toBeVisible();
      await expect(batch.getByRole("button", { name: "Try again" })).toHaveCount(0);

      const chooser = page.waitForEvent("filechooser");
      await batch.getByRole("button", { name: "Choose again" }).click();
      await (await chooser).setFiles(photo);
      await expect(batch.getByText("1 of 1 sent")).toBeVisible({ timeout: 60_000 });
      await expect(batch.getByText("This photo changed after you chose it")).toHaveCount(0);

      // The status page heard why: the error's name and which read, never the file's name.
      const guestId = await ownGuestId(context);
      await expect
        .poll(async () => sql`select reason, detail from upload_events where guest_id = ${guestId} and kind = 'failed'`, { timeout: 20_000 })
        .toEqual([
          {
            reason: "file-changed",
            detail: expect.objectContaining({ errorName: "NotReadableError", read: "head", errorMessage: expect.stringContaining("could not be read") }),
          },
        ]);
      const [{ detail }] = await sql`select detail from upload_events where guest_id = ${guestId} and kind = 'failed'`;
      expect(JSON.stringify(detail)).not.toContain("WA0007");
    } finally {
      await context.close();
    }
  });

  test("Ruling BE: a big video says it may take a while; minimised, a floating circle carries its progress, opens the card again when tapped, and turns to a check and fades once sent", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      // A size of its own, so no earlier run's upload of it is carried on.
      const size = 300_000_000 + Math.floor(Math.random() * 1_000_000);
      const video = await sparseOnDisk("VID_speeches.mp4", size);
      const requests = { starts: 0, presigns: [] as number[][], puts: 0, completes: 0 };
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (request.method() === "PUT" && url.pathname.includes("/nona-private/originals/")) requests.puts += 1;
        else if (request.method() === "POST" && url.pathname === "/api/uploads") requests.starts += 1;
        else if (request.method() === "POST" && url.pathname.endsWith("/parts")) requests.presigns.push(JSON.parse(request.postData() ?? "{}").partNumbers);
        else if (url.pathname.endsWith("/complete")) requests.completes += 1;
      });
      // Mobile data: about 12 MB/s out, so it takes a while.
      const network = await context.newCDPSession(page);
      await network.send("Network.enable");
      await network.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: -1, uploadThroughput: 12_000_000 });

      await picker(page, "Choose photos & videos").setInputFiles(video);
      const batch = page.getByRole("region", { name: "Your photos and videos" });
      await expect(
        batch.getByText(
          "This is a big video, so it may take a few minutes on mobile data. You can minimise this and keep looking through the album; just keep this page open.",
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(batch.getByText(/(about .+|less than a minute) left/)).toBeVisible({ timeout: 30_000 });

      await batch.getByRole("button", { name: "Minimise" }).click();
      await expect(batch).toHaveCount(0);
      const circle = page.getByRole("button", { name: /^Show uploads/ });
      await expect(circle).toBeVisible();
      await expect(circle).toBeFocused();
      const percentOf = async () => Number(/(\d+)% sent/.exec((await circle.getAttribute("aria-label")) ?? "")?.[1] ?? -1);
      const first = await percentOf();
      expect(first).toBeGreaterThanOrEqual(0);
      await expect.poll(percentOf, { timeout: 30_000 }).toBeGreaterThan(first);
      // The ring follows: its stroke shows the same share sent.
      await expect(circle.locator("[data-ring]")).toHaveAttribute("data-percent", /\d+/);

      await circle.click();
      await expect(batch).toBeVisible();
      await expect(batch).toBeFocused();
      await batch.getByRole("button", { name: "Minimise" }).click();
      await expect(circle).toBeFocused();

      // The connection opens up and the rest goes: a check, then the circle fades away.
      await network.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await expect(page.locator('[data-upload-circle][data-state="done"]')).toBeVisible({ timeout: 90_000 });
      await expect(page.locator("[data-upload-circle]")).toHaveCount(0, { timeout: 10_000 });

      // 16 MiB parts for a file this big, the first presign only the six sent at once.
      const parts = Math.ceil(size / (16 * MEBIBYTE));
      console.info(`[measure] ${size} B: ${requests.starts} start, ${requests.presigns.length} presigns (${requests.presigns.map((numbers) => numbers.length).join(" + ")} parts), ${requests.puts} part PUTs, ${requests.completes} complete`);
      expect(parts).toBe(18);
      expect(requests.puts).toBe(parts);
      expect(requests.presigns[0]).toEqual([1, 2, 3, 4, 5, 6]);
      expect(requests.presigns.flat().sort((first, second) => first - second)).toEqual(Array.from({ length: parts }, (_slot, index) => index + 1));
    } finally {
      await context.close();
    }
  });

  test("Ruling BE: back after a reload mid-upload, the album says the video didn't finish, and Choose carries it on from where it stopped", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const video = await bytesOnDisk("IMG_0533.MOV", 30 * MEBIBYTE);
      let reloaded = false;
      const puts = await watchPartPuts(page, (partNumber) => (reloaded || partNumber === 1 ? "send" : "hold"));
      await picker(page, "Record video").setInputFiles(video);
      await expect.poll(() => puts.finished, { timeout: 30_000 }).toEqual([1]);

      reloaded = true;
      await page.reload();
      await Promise.all(puts.held.splice(0).map((route) => route.abort().catch(() => {})));
      const notice = inMain(page).getByText("Your video didn't finish sending. Choose it again and it'll carry on from where it stopped.");
      await expect(notice).toBeVisible();

      const sentBefore = puts.sent.length;
      const chooser = page.waitForEvent("filechooser");
      await inMain(page).getByRole("button", { name: "Choose", exact: true }).click();
      await (await chooser).setFiles(video);
      await expect(page.getByRole("region", { name: "Your photos and videos" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      // Part 1 wasn't sent again.
      expect(ascending(puts.sent.slice(sentBefore))).toEqual([2, 3, 4]);
      await expect(notice).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("Not now sets the notice on return aside, for good, without forgetting the upload", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const video = await bytesOnDisk("IMG_0611.MOV", 20 * MEBIBYTE);
      let reloaded = false;
      const puts = await watchPartPuts(page, (partNumber) => (reloaded || partNumber === 1 ? "send" : "hold"));
      await picker(page, "Record video").setInputFiles(video);
      await expect.poll(() => puts.finished, { timeout: 30_000 }).toEqual([1]);

      reloaded = true;
      await page.reload();
      await Promise.all(puts.held.splice(0).map((route) => route.abort().catch(() => {})));
      const notice = inMain(page).getByText("Your video didn't finish sending. Choose it again and it'll carry on from where it stopped.");
      await expect(notice).toBeVisible();
      await inMain(page).getByRole("button", { name: "Not now" }).click();
      await expect(notice).toHaveCount(0);
      await reloadAlbum(page);
      await page.waitForTimeout(500);
      await expect(notice).toHaveCount(0);
      // The upload is still remembered: the album, once closed, still offers to finish it.
      expect(await page.evaluate(() => Object.keys(JSON.parse(window.localStorage.getItem("nona:started-files") ?? "{}")).length)).toBe(1);
    } finally {
      await context.close();
    }
  });
});

test.describe("when sharing isn't open", () => {
  test("before it opens, and once it has closed, the album says so plainly instead of offering buttons", async ({ page }) => {
    await saveSetting("uploads_open", false);
    await saveSetting("uploads_closed_at", null);
    await page.goto("/album");
    const main = inMain(page);
    await expect(main.getByText("Photo and video sharing opens on the wedding weekend")).toBeVisible();
    await expect(main.getByText("Saturday 5 and Sunday 6 December. Come back here with your camera ready.")).toBeVisible();
    await expect(main.getByRole("link", { name: "Add to calendar" })).toHaveAttribute("href", "/calendar");
    await expect(main.getByText("Album · #NONA26")).toBeVisible();
    await expect(page.getByText(/Live album/)).toHaveCount(0);
    await expect(page.getByText(/Sharing as/)).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    await saveSetting("uploads_closed_at", new Date().toISOString());
    await page.reload();
    await expect(main.getByText("Sharing has closed")).toBeVisible();
    await expect(main.getByText("Thank you for every photo and video. The album stays here for you to look through.")).toBeVisible();
    await expect(page.getByText("Photo and video sharing opens on the wedding weekend")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  test("after the close, a phone that hadn't finished an upload can finish it, for 24 hours; another phone sees the closed card", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const context = await phone(browser, baseURL);
    const otherPhone = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      const video = await bytesOnDisk("unfinished.mp4", 20 * MEBIBYTE);
      // Part 1 arrives; parts 2 and 3 get no answer before the page goes.
      let closed = false;
      const puts = await watchPartPuts(page, (partNumber) => (closed || partNumber === 1 ? "send" : "hold"));
      await picker(page, "Record video").setInputFiles(video);
      await expect.poll(() => puts.finished, { timeout: 30_000 }).toEqual([1]);

      await saveSetting("uploads_open", false);
      await saveSetting("uploads_closed_at", new Date().toISOString());
      closed = true;
      await page.reload();
      await Promise.all(puts.held.splice(0).map((route) => route.abort().catch(() => {})));

      const finish = inMain(page).getByText("Finish sending what you started");
      await expect(finish).toBeVisible();
      await expect(page.getByText(/Live album/)).toHaveCount(0);
      await picker(page, "Finish sending what you started").setInputFiles(video);
      await expect(page.getByRole("region", { name: "Your photos and videos" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
      expect(ascending(puts.sent)).toEqual([1, 2, 3]);

      const elsewhere = await otherPhone.newPage();
      await elsewhere.goto("/album");
      await expect(inMain(elsewhere).getByText("Sharing has closed")).toBeVisible();
      await expect(elsewhere.locator('input[type="file"]')).toHaveCount(0);
    } finally {
      await context.close();
      await otherPhone.close();
    }
  });

  test("a file picked after the couple close sharing gets the plain closed message, with no Try again", async ({ browser, baseURL }) => {
    const context = await phone(browser, baseURL);
    try {
      const page = await context.newPage();
      await openAlbum(page);
      await saveSetting("uploads_open", false);
      await saveSetting("uploads_closed_at", new Date().toISOString());

      await picker(page, "Take a photo").setInputFiles(await photoOnDisk("late.jpg", 300, 200));

      const card = page.getByRole("region", { name: "Your photo" });
      await expect(card.getByText("Sharing has closed")).toBeVisible({ timeout: 30_000 });
      await expect(card.getByText(CLOSED_MESSAGE)).toBeVisible();
      await expect(card.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Take another" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("the share buttons on small phones", () => {
  for (const width of [320, 360]) {
    test(`fit their words at ${width}px on the wedding weekend`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage();
        await page.goto("/album?mode=day");
        await page.evaluate(() => document.fonts.ready);
        for (const name of ["Record video", "From your phone"]) {
          // Visible only: a hidden streamed copy of the buttons can sit beside them until the swap.
          const pill = page.locator("label", { hasText: name }).filter({ visible: true });
          await expect(pill).toBeVisible();
          const { scrollWidth, clientWidth } = await pill.evaluate((element) => ({
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          }));
          expect(scrollWidth, `"${name}" needs ${scrollWidth}px in ${clientWidth}px`).toBeLessThanOrEqual(clientWidth);
        }
        // At 340 px and under the icons make way for the words.
        const iconsShown = await page
          .locator("label", { hasText: "From your phone" })
          .filter({ visible: true })
          .locator("svg")
          .isVisible();
        expect(iconsShown).toBe(width > 340);
      } finally {
        await context.close();
      }
    });
  }
});
