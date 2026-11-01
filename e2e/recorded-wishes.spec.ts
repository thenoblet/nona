import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { TEST_DB_ENV } from "../test/env";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

/*
 * Voice and video wishes (Task 16), against the production build, MinIO and the media worker's
 * image: Chromium records from its fake camera and microphone (the flags below), the recording goes
 * up through the upload client, the wish waits as "Getting your wish ready…" for its sender only
 * (Ruling BR) until the worker has made it, then plays on everyone's wall; the couple play it in the
 * admin and hide it. The worker is held (docker pause) while the sender's "getting ready" is
 * checked, so a fast worker can't finish first.
 */

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
});
test.describe.configure({ mode: "serial", timeout: 240_000 });

const run = promisify(execFile);
const WORKER = "nona-e2e-worker";

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

/** Every wish this file sends is signed with this, so it can take them off the wall again. */
const SIGNED_PREFIX = "E2E Recorded";

test.afterAll(async () => {
  // Whatever happened, the worker takes jobs again for the specs after this one.
  await run("docker", ["unpause", WORKER]).catch(() => {});
  // Off the wall, so a spec that expects an empty wall finds one whatever order they run in. Their
  // recordings stay as orphans would: on no wall and in no list.
  await sql`delete from wishes where signed_as like ${`${SIGNED_PREFIX} %`}`;
  await sql.end();
});

/** A phone: touch, a phone-sized screen, a guest of its own once it records. */
function phone(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

/** Holds the media worker (docker pause) while `check` runs, then lets it go. */
async function withWorkerHeld(check: () => Promise<void>): Promise<void> {
  await run("docker", ["pause", WORKER]);
  try {
    await check();
  } finally {
    await run("docker", ["unpause", WORKER]);
  }
}

const wall = (page: Page) => page.locator("section[aria-labelledby='wall-h']");
const composer = (page: Page) => page.getByRole("region", { name: "Write your wish" });

/** Records a few seconds with the fake device, stopped by the guest. */
async function record(page: Page, kind: "voice" | "video"): Promise<void> {
  await composer(page).getByRole("tab", { name: kind === "voice" ? "Voice note" : "Video" }).click();
  await page.getByRole("button", { name: kind === "voice" ? "Start recording a voice note" : "Start recording a video message" }).click();
  if (kind === "video") await expect(page.getByText(/^Recording in [123]…$/)).toBeVisible();
  const left = composer(page).getByText(/^0:\d\d left$/);
  await expect(left).toBeVisible({ timeout: 15_000 });
  // The send waits while it records, and so do the other tabs.
  await expect(page.getByRole("button", { name: "Send my wish" })).toBeDisabled();
  await expect(composer(page).getByRole("tab", { name: "Write" })).toHaveAttribute("aria-disabled", "true");
  await page.waitForTimeout(2_500);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("button", { name: kind === "voice" ? "Listen back" : "Watch it back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record again" })).toBeVisible();
}

/** Signs and sends the recording, and waits for gate B's thank-you. */
async function send(page: Page, signedAs: string, kind: "voice" | "video"): Promise<void> {
  await page.getByLabel("Sign your wish").fill(signedAs);
  await page.getByRole("button", { name: "Send my wish" }).click();
  await expect(page.getByText("Sending your wish")).toBeVisible();
  const thanks = page.getByRole("status").filter({ hasText: "Thank you" });
  await expect(thanks).toBeVisible({ timeout: 60_000 });
  await expect(thanks).toContainText(`${signedAs}, your ${kind === "voice" ? "voice note" : "video message"} will be on the wall below in a moment.`);
}

let voiceSigner = "";

test("a voice wish is sent, shows 'Getting your wish ready…' to its sender only, then plays on every wall once the worker has made it", async ({ browser, baseURL }) => {
  voiceSigner = `${SIGNED_PREFIX} Voice ${randomUUID().slice(0, 6)}`;
  const sender = await phone(browser, baseURL);
  const someoneElse = await phone(browser, baseURL);
  try {
    const page = await sender.newPage();
    await page.goto("/wishes");
    await record(page, "voice");

    await withWorkerHeld(async () => {
      await send(page, voiceSigner, "voice");
      const pending = wall(page).locator("[data-pending-wish='processing']");
      await expect(pending).toContainText("Getting your wish ready…");
      await expect(pending).toContainText(`${voiceSigner} · voice note`);

      const other = await someoneElse.newPage();
      await other.goto("/wishes");
      await expect(wall(other).getByText("Getting your wish ready…")).toHaveCount(0);
      await expect(wall(other).getByText(voiceSigner)).toHaveCount(0);
      await other.close();
    });

    // The worker makes it; the sender's card asks after it, and the wall turns it into the player.
    const play = wall(page).getByRole("button", { name: `Play voice note from ${voiceSigner}` });
    await expect(play).toBeVisible({ timeout: 120_000 });
    await expect(wall(page).getByText("Getting your wish ready…")).toHaveCount(0);
    const audio = play.locator("xpath=ancestor::article").locator("audio");
    await expect(audio).toHaveAttribute("preload", "none");
    await expect(audio).toHaveAttribute("src", /\/derived\/[0-9a-f-]+\/[0-9a-f]{16}\/audio\.m4a$/);

    const other = await someoneElse.newPage();
    await other.goto("/wishes");
    await expect(wall(other).getByRole("button", { name: `Play voice note from ${voiceSigner}` })).toBeVisible();
    // Tapped, it plays the M4A the worker made.
    await wall(other).getByRole("button", { name: `Play voice note from ${voiceSigner}` }).click();
    await expect(wall(other).getByRole("button", { name: `Pause voice note from ${voiceSigner}` })).toBeVisible();

    const [row] = await sql`select w.kind, m.purpose, m.kind as recording, m.status, m.duration_seconds from wishes w join media m on m.id = w.media_id where w.signed_as = ${voiceSigner}`;
    expect(row).toMatchObject({ kind: "voice", purpose: "wish", recording: "audio", status: "ready" });
    expect(Number(row.duration_seconds)).toBeGreaterThan(1);
  } finally {
    await sender.close();
    await someoneElse.close();
  }
});

test("a video wish counts down, records from the front camera, and plays with its poster once made", async ({ browser, baseURL }) => {
  const signer = `${SIGNED_PREFIX} Video ${randomUUID().slice(0, 6)}`;
  const sender = await phone(browser, baseURL);
  const someoneElse = await phone(browser, baseURL);
  try {
    const page = await sender.newPage();
    await page.goto("/wishes");
    await record(page, "video");

    await withWorkerHeld(async () => {
      await send(page, signer, "video");
      await expect(wall(page).locator("[data-pending-wish='processing']")).toContainText(`${signer} · video`);
      const other = await someoneElse.newPage();
      await other.goto("/wishes");
      await expect(wall(other).getByText("Getting your wish ready…")).toHaveCount(0);
      await expect(wall(other).getByText(signer)).toHaveCount(0);
      await other.close();
    });

    const play = wall(page).getByRole("button", { name: `Play video message from ${signer}` });
    await expect(play).toBeVisible({ timeout: 120_000 });
    const video = wall(page).getByLabel(`Video message from ${signer}`, { exact: true });
    await expect(video).toHaveAttribute("preload", "none");
    await expect(video).toHaveAttribute("src", /\/video\.mp4$/);
    await expect(video).toHaveAttribute("poster", /\/poster-view\.webp$/);
    await play.click();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 20_000 }).toBeGreaterThan(0);

    const [row] = await sql`select m.kind, m.status, m.width, m.height, m.video_codec from wishes w join media m on m.id = w.media_id where w.signed_as = ${signer}`;
    expect(row).toMatchObject({ kind: "video", status: "ready" });
    expect(Math.max(row.width, row.height)).toBeLessThanOrEqual(1280);
    expect(Math.min(row.width, row.height)).toBeLessThanOrEqual(720);
  } finally {
    await sender.close();
    await someoneElse.close();
  }
});

/** A second of a 440 Hz tone as a 16-bit mono WAV: what a phone's own recorder might hand back. */
function toneWav(): Buffer {
  const sampleRate = 8_000;
  const samples = sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("when the browser refuses the camera or microphone, the phone's own camera or recorder takes over, and what it records is sent", async ({ browser, baseURL }) => {
  const context = await phone(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    await page.goto("/wishes");

    await composer(page).getByRole("tab", { name: "Video" }).click();
    await page.getByRole("button", { name: "Start recording a video message" }).click();
    await expect(page.getByText("Your browser won't let us use the camera here.")).toBeVisible();
    await expect(page.getByText("Open my camera")).toBeVisible();
    await expect(page.getByText("Or open this page in Chrome or Safari to record here.")).toBeVisible();
    const cameraInput = composer(page).locator("input[type=file]");
    await expect(cameraInput).toHaveAttribute("accept", "video/*");
    await expect(cameraInput).toHaveAttribute("capture", "user");

    await composer(page).getByRole("tab", { name: "Voice note" }).click();
    await page.getByRole("button", { name: "Start recording a voice note" }).click();
    await expect(page.getByText("Your browser won't let us use the microphone here.")).toBeVisible();
    await expect(page.getByText("Open my recorder")).toBeVisible();
    const recorderInput = composer(page).locator("input[type=file]");
    await expect(recorderInput).toHaveAttribute("accept", "audio/*");

    // What the phone's recorder hands back comes here to listen to and send, like any other.
    await recorderInput.setInputFiles({ name: "Recording 1.wav", mimeType: "audio/wav", buffer: toneWav() });
    await expect(page.getByRole("button", { name: "Listen back" })).toBeVisible();
    await send(page, `${SIGNED_PREFIX} Fallback ${randomUUID().slice(0, 6)}`, "voice");
  } finally {
    await context.close();
  }
});

test("the couple play a recorded wish in the admin's Wishes tab and hide it, and the wall no longer shows it", async ({ browser, baseURL, request }) => {
  expect(voiceSigner).not.toBe("");
  const [wish] = await sql`select id from wishes where signed_as = ${voiceSigner}`;
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
  try {
    const page = await context.newPage();
    await page.goto("/admin/photos/wishes");
    const row = page.locator(`[data-wish="${wish.id}"]`);
    // Visible only: while the page streams in, a hidden copy of the row can sit beside it.
    const audio = row.getByLabel(`Voice note from ${voiceSigner}`, { exact: true }).filter({ visible: true });
    await expect(audio).toHaveAttribute("preload", "none");
    await expect(audio).toHaveAttribute("src", /\/audio\.m4a$/);
    await audio.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime), { timeout: 20_000 }).toBeGreaterThan(0);

    await row.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByText(`Hidden. ${voiceSigner}'s wish is off the wall.`)).toBeVisible();
    // Hidden, its played file is withdrawn: the admin offers only its original.
    await page.reload();
    await expect(page.locator(`[data-wish="${wish.id}"]`).locator("audio")).toHaveCount(0);
    expect(await (await request.get("/wishes")).text()).not.toContain(voiceSigner);
  } finally {
    await context.close();
  }
});
