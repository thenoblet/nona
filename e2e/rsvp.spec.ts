import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";
import sharp from "sharp";
import { rsvp as builtInRsvp } from "../src/content/wedding";
import { TEST_DB_ENV } from "../test/env";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

// The e2e server is a production build, so the guest cookie carries the __Host- prefix.
const GUEST_COOKIE = "__Host-nona_guest";

/** The phone's own guest, as the uploader asks for it before its first upload. */
async function ownGuestOf(phone: BrowserContext): Promise<string> {
  const response = await phone.request.post("/api/guest", { data: {} });
  expect(response.ok()).toBe(true);
  return (await response.json()).guestId;
}

const moments = (page: Page) => page.getByRole("main").getByRole("list", { name: "Moments" });

function testDb() {
  return postgres({
    host: TEST_DB_ENV.POSTGRES_HOST,
    port: Number(TEST_DB_ENV.POSTGRES_PORT),
    database: TEST_DB_ENV.POSTGRES_DB,
    user: TEST_DB_ENV.POSTGRES_USER,
    password: TEST_DB_ENV.POSTGRES_PASSWORD,
    max: 1,
    connect_timeout: 5,
  });
}

test("a guest can send a reply and it is saved", async ({ page }) => {
  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Guest");
  await page.getByLabel("Phone or WhatsApp").fill("0244000111");
  await page.getByLabel("Email").fill("e2e-guest@example.com");
  await page
    .getByRole("radiogroup", { name: /white wedding/i })
    .getByText("Joyfully accept")
    .click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

  const sql = testDb();
  try {
    const rows = await sql`SELECT full_name FROM rsvps WHERE email = 'e2e-guest@example.com'`;
    expect(rows).toHaveLength(1);
  } finally {
    await sql.end();
  }
});

test("a second reply is kept beside the first, and the guest is told nothing about the first", async ({ page }) => {
  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Second Reply");
  await page.getByLabel("Phone or WhatsApp").fill("0244000333");
  await page.getByLabel("Email").fill("e2e-second-reply@example.com");
  await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  const thankYou = page.locator("section[aria-labelledby='sent-h']");
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  const firstScreen = await thankYou.innerText();

  await page.getByRole("button", { name: "Change my reply" }).click();
  await page.getByLabel("Phone or WhatsApp").fill("+233 24 400 0333");
  await page.getByLabel("How many in your party?").selectOption("2 people");
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

  // The same thank-you as the first time: nothing says an earlier reply was found.
  expect(await thankYou.innerText()).toBe(firstScreen);

  const sql = testDb();
  try {
    const rows = await sql`
      SELECT superseded_at FROM rsvps WHERE email = 'e2e-second-reply@example.com' ORDER BY received_at
    `;
    expect(rows.map((row) => row.superseded_at)).toEqual([null, null]);
  } finally {
    await sql.end();
  }
});

test("a reply's own guest is known only through its email: the phone that sent it gets no cookie, and the emailed link keeps the guest's photos together on any phone", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const phone = () => browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const [sender, dayPhone, otherPhone] = [await phone(), await phone(), await phone()];
  const sql = testDb();
  let guestId: string | undefined;
  try {
    const page = await sender.newPage();
    await page.goto("/rsvp");
    // A plain name, so the guest takes it (Ruling CC); "E2E …" would not be one.
    await page.getByLabel("Your full name").fill("Abena Album-Link");
    await page.getByLabel("Phone or WhatsApp").fill("0244000555");
    await page.getByLabel("Email").fill("e2e-album-link@example.com");
    await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
    await page.getByRole("button", { name: "Send my reply" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

    // Whoever typed the address never holds the guest its email links to (Ruling CB).
    expect((await sender.cookies()).filter((cookie) => cookie.name === GUEST_COOKIE)).toEqual([]);
    const [reply] = await sql`
      SELECT rsvps.guest_id, guests.link_token, guests.display_name
      FROM rsvps JOIN guests ON guests.id = rsvps.guest_id
      WHERE rsvps.email = 'e2e-album-link@example.com'`;
    expect(reply.display_name).toBe("Abena Album-Link");
    const replyGuestId: string = reply.guest_id;
    guestId = replyGuestId;

    // On the day, a phone with no guest opens the emailed link, says "Yes, that's me", and uploads as that guest.
    const day = await dayPhone.newPage();
    await day.goto(`/my/${reply.link_token}`);
    await expect(day.getByRole("heading", { name: "Is this you, Abena Album-Link?" })).toBeVisible();
    await day.getByRole("button", { name: "Yes, that's me" }).click();
    await expect(day).toHaveURL(/\/album\?view=mine$/);
    expect(await ownGuestOf(dayPhone)).toBe(replyGuestId);
    await day.goto("/album?mode=before");
    await expect(day.getByRole("main").getByText("Choose photos & videos")).toBeVisible();
    const photo = await sharp(randomBytes(900 * 600 * 3), { raw: { width: 900, height: 600, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
    await day.getByRole("main").getByLabel("Take a photo").setInputFiles({ name: "rsvp-link.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect(day.getByRole("region", { name: "Your photo" }).getByText("Added to the album")).toBeVisible({ timeout: 60_000 });
    const [{ id: mediaId }] = await sql`SELECT id FROM media WHERE guest_id = ${replyGuestId}`;
    await expect.poll(async () => (await sql`SELECT status FROM media WHERE id = ${mediaId}`)[0].status, { timeout: 60_000 }).toBe("ready");
    await day.goto("/album?mode=before&view=mine");
    await expect(moments(day).locator(`[data-moment="${mediaId}"]`)).toBeVisible();

    // The same link on another phone brings that upload there too, under My uploads.
    const other = await otherPhone.newPage();
    await other.goto(`/my/${reply.link_token}`);
    await other.getByRole("button", { name: "Yes, that's me" }).click();
    await expect(other).toHaveURL(/\/album\?view=mine$/);
    await expect(other.getByRole("main").getByRole("tab", { name: "My uploads" })).toHaveAttribute("aria-selected", "true");
    await expect(moments(other).locator(`[data-moment="${mediaId}"]`).getByRole("img", { name: "Your upload" })).toBeVisible();
  } finally {
    // Later specs count the album's photos.
    if (guestId) await sql`DELETE FROM media WHERE guest_id = ${guestId}`;
    await sql.end();
    for (const context of [sender, dayPhone, otherPhone]) await context.close();
  }
});

test("a reply under a name that isn't a plain name gets an unnamed guest: its link's page never shows that text", async ({ browser, baseURL }) => {
  const [sender, recipient] = [await browser.newContext({ baseURL }), await browser.newContext({ baseURL })];
  const sql = testDb();
  try {
    // Anyone can reply with someone else's address and any name (Ruling CC).
    const page = await sender.newPage();
    await page.goto("/rsvp");
    await page.getByLabel("Your full name").fill("Claim your gift at evil.example");
    await page.getByLabel("Phone or WhatsApp").fill("0244000666");
    await page.getByLabel("Email").fill("e2e-not-a-name@example.com");
    await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
    await page.getByRole("button", { name: "Send my reply" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

    const [reply] = await sql`
      SELECT guests.link_token, guests.display_name
      FROM rsvps JOIN guests ON guests.id = rsvps.guest_id
      WHERE rsvps.email = 'e2e-not-a-name@example.com'`;
    expect(reply.display_name).toBeNull();

    const linked = await recipient.newPage();
    await linked.goto(`/my/${reply.link_token}`);
    await expect(linked.getByRole("heading", { name: "Is this your link?" })).toBeVisible();
    await expect(linked.getByText("evil.example")).toHaveCount(0);
  } finally {
    await sql.end();
    await sender.close();
    await recipient.close();
  }
});

/** Fills the form with one guest's reply to the white wedding, without sending it. */
async function fillReply(page: Page, name: string, email: string) {
  await page.getByLabel("Your full name").fill(name);
  await page.getByLabel("Phone or WhatsApp").fill("0244000444");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
}

async function repliesFrom(email: string): Promise<number> {
  const sql = testDb();
  try {
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM rsvps WHERE email = ${email}`;
    return count;
  } finally {
    await sql.end();
  }
}

/** The Replies page, signed in through Cloudflare Access, and its RSVP settings panel. */
async function rsvpSettings(browser: Browser, baseURL: string | undefined, email?: string) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken({ email }) } });
  const page = await context.newPage();
  await page.goto("/admin/rsvps");
  // The panel works once the page has hydrated.
  await page.waitForLoadState("networkidle");
  return { page, panel: page.getByRole("region", { name: "RSVP settings" }), done: () => context.close() };
}

/** Close RSVPs or Reopen RSVPs, through the confirm step. */
async function switchReplies(panel: Locator, action: "Close RSVPs" | "Reopen RSVPs") {
  await panel.getByRole("button", { name: action }).click();
  await panel.getByRole("button", { name: `Yes, ${action.toLowerCase().replace("rsvps", "RSVPs")}` }).click();
  await expect(panel.getByRole("button", { name: action === "Close RSVPs" ? "Reopen RSVPs" : "Close RSVPs" })).toBeVisible();
}

async function saveReplyBy(panel: Locator, day: string) {
  await panel.getByLabel("Reply by").fill(day);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("Saved. Guests see it now.")).toBeVisible();
}

const WHATSAPP = "WhatsApp/2.23.20.0";
// One of the crawlers added to Next's list in next.config.ts.
const SNAPCHAT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Snap URL Preview Service; bot; snapchat; https://developers.snap.com/robots)";

/**
 * The link-preview tags a crawler such as WhatsApp's reads: the <head> of the first HTML, which it
 * reads without running scripts, so tags streamed in later would never reach it.
 */
async function previewTags(request: APIRequestContext, path: string, userAgent = WHATSAPP) {
  const html = await (await request.get(path, { headers: { "user-agent": userAgent } })).text();
  expect(html).toContain("</head>");
  const head = html.slice(0, html.indexOf("</head>"));
  const tag = (property: string) => new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(head)?.[1];
  return { description: tag("og:description"), image: tag("og:image") };
}

/**
 * At the end of the page, how far the signature under the closed message sits above the floating
 * music pill (negative when the pill covers it), or null when no pill is beneath it. Only the
 * section on screen counts, not a hidden copy left from streaming.
 */
async function signatureClearance(page: Page): Promise<number | null> {
  await page.getByText("Play our song").waitFor();
  // The page scrolls smoothly; measure at the end, not on the way there.
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  return page.evaluate(() => {
    const section = [...document.querySelectorAll("section[aria-label='Replies have closed']")].find((element) =>
      element.checkVisibility(),
    );
    const signature = [...(section?.querySelectorAll("p") ?? [])].at(-1)?.getBoundingClientRect();
    if (!signature || signature.height === 0) throw new Error("No signature on screen");
    const dock = document.querySelector("div.pointer-events-none.fixed")!;
    const beneath = [...dock.querySelectorAll(":scope > div")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.height > 0 && rect.left < signature.right && rect.right > signature.left);
    return beneath.length === 0 ? null : Math.min(...beneath.map((rect) => rect.top)) - signature.bottom;
  });
}

/** Breaks the envelope's seal on /open (it never stops pulsing, so the click is forced). */
async function openInvitation(page: Page) {
  await page.goto("/open");
  await page.getByRole("button", { name: "Break the seal to open your invitation" }).click({ force: true });
}

async function previewImage(request: APIRequestContext, url: string | undefined): Promise<Buffer> {
  expect(url).toBeTruthy();
  const response = await request.get(new URL(url!).pathname + new URL(url!).search);
  expect(response.headers()["content-type"]).toBe("image/jpeg");
  return response.body();
}

test.describe("the couple's RSVP switch", () => {
  // Each test leaves replies open, by 20 November, with the built-in message, for the tests after it.
  test.afterEach(async ({ browser, baseURL }) => {
    const { panel, done } = await rsvpSettings(browser, baseURL);
    if (await panel.getByRole("button", { name: "Reopen RSVPs" }).isVisible()) await switchReplies(panel, "Reopen RSVPs");
    if ((await panel.getByLabel("Reply by").inputValue()) !== builtInRsvp.replyBy) await saveReplyBy(panel, builtInRsvp.replyBy);
    await done();
  });

  test("closing: /rsvp shows the message, a reply from a page opened earlier is refused, and the site and previews say so", async ({
    page,
    browser,
    baseURL,
    request,
  }) => {
    const openCard = await previewImage(request, (await previewTags(request, "/rsvp")).image);
    await page.goto("/rsvp");
    await fillReply(page, "E2E Too Late", "e2e-too-late@example.com");

    const { page: admin, panel, done } = await rsvpSettings(browser, baseURL);
    await expect(panel.getByText("Open", { exact: true })).toBeVisible();
    // Unsaved edits to the date or message hold the switch until they are saved or undone.
    await panel.getByLabel("Message while closed").fill("Not saved yet");
    await expect(panel.getByRole("button", { name: "Close RSVPs" })).toBeDisabled();
    await expect(panel.getByText("Save or undo your changes first")).toBeVisible();
    await panel.getByRole("button", { name: "Undo changes" }).click();
    await expect(panel.getByLabel("Message while closed")).toHaveValue(builtInRsvp.closedMessage);
    await panel.getByRole("button", { name: "Close RSVPs" }).click();
    await expect(panel.getByRole("group")).toContainText(`The RSVP page will show guests “${builtInRsvp.closedMessage}”`);
    await panel.getByRole("button", { name: "Yes, close RSVPs" }).click();
    await expect(panel.getByText(/^Closed since \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} by couple@example\.com$/)).toBeVisible();
    await expect(admin.getByText("Newest first. RSVPs are closed.")).toBeVisible();
    await done();

    // The page opened before the close still has its form: the reply is refused with the message.
    await page.getByRole("button", { name: "Send my reply" }).click();
    await expect(page.getByText(builtInRsvp.closedMessage)).toBeVisible();
    await expect(page.getByText(builtInRsvp.closedMessage)).toHaveCSS("white-space", "pre-line");
    expect(await repliesFrom("e2e-too-late@example.com")).toBe(0);

    await page.goto("/rsvp");
    await expect(page.getByText(builtInRsvp.closedMessage).filter({ visible: true })).toBeVisible();
    // Line breaks the couple type into the message are kept.
    await expect(page.getByText(builtInRsvp.closedMessage).filter({ visible: true })).toHaveCSS("white-space", "pre-line");
    await expect(page.getByRole("button", { name: "Send my reply" })).toHaveCount(0);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Replies have closed.");
    // On a phone, scrolled to the end, the signature clears the floating music pill.
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await signatureClearance(page), `at ${width}px`).toBeGreaterThan(0);
    }
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto("/home?mode=before");
    // The home page streams in: until the swap, a hidden copy sits beside the visible one.
    const replySection = page.locator("section#rsvp").filter({ visible: true });
    await expect(replySection.getByRole("heading", { name: "Replies have closed" })).toBeVisible();
    await expect(replySection.getByText("Répondez s'il vous plaît")).toHaveCount(0);
    await expect(replySection.getByText(builtInRsvp.closedMessage)).toHaveCSS("white-space", "pre-line");
    await expect(replySection.getByRole("link", { name: "Respond now" })).toHaveCount(0);
    await expect(page.getByLabel("Your invitation").filter({ visible: true }).getByText("Replies have closed")).toBeVisible();
    await openInvitation(page);
    await expect(page.getByText("Replies have closed")).toBeVisible();
    await expect(page.getByText(/Kindly reply by/)).toHaveCount(0);

    const rsvpPreview = await previewTags(request, "/rsvp");
    expect(rsvpPreview.description).toBe("Replies have closed.");
    expect((await previewTags(request, "/")).description).toMatch(/Tepa, Ashanti\. Replies have closed\.$/);
    expect((await previewImage(request, rsvpPreview.image)).equals(openCard)).toBe(false);
  });

  test("reopening: the form is back and a reply is saved", async ({ page, browser, baseURL }) => {
    const { panel, done } = await rsvpSettings(browser, baseURL);
    await switchReplies(panel, "Close RSVPs");
    await page.goto("/rsvp");
    await expect(page.getByRole("button", { name: "Send my reply" })).toHaveCount(0);

    await switchReplies(panel, "Reopen RSVPs");
    await expect(panel.getByText("Open", { exact: true })).toBeVisible();
    await done();

    await page.goto("/rsvp");
    await fillReply(page, "E2E After Reopening", "e2e-reopened@example.com");
    await page.getByRole("button", { name: "Send my reply" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
    expect(await repliesFrom("e2e-reopened@example.com")).toBe(1);
  });

  test("a new reply-by date reaches the RSVP page, its description, the home letter and link previews with no deploy", async ({
    page,
    browser,
    baseURL,
    request,
  }) => {
    expect((await previewTags(request, "/")).description).toMatch(/Kindly reply by 20 November\.$/);
    const before = await previewTags(request, "/rsvp");
    expect(before.description).toContain("Please reply by 20 November;");
    const cardBefore = await previewImage(request, before.image);

    const { panel, done } = await rsvpSettings(browser, baseURL);
    await saveReplyBy(panel, "2026-11-27");
    await done();

    await page.goto("/rsvp");
    await expect(page.getByText("Please reply by 27 November").filter({ visible: true })).toBeVisible();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Please reply by 27 November;/);
    await page.goto("/home?mode=before");
    await expect(page.getByLabel("Your invitation").filter({ visible: true }).getByText("Kindly reply by 27 November")).toBeVisible();
    await openInvitation(page);
    await expect(page.getByText("Kindly reply by 27 November")).toBeVisible();

    // WhatsApp's and Snapchat's crawlers get the new date in the <head> of the first HTML.
    expect((await previewTags(request, "/")).description).toMatch(/Kindly reply by 27 November\.$/);
    expect((await previewTags(request, "/", SNAPCHAT)).description).toMatch(/Kindly reply by 27 November\.$/);
    const after = await previewTags(request, "/rsvp");
    expect(after.description).toContain("Please reply by 27 November;");
    expect((await previewImage(request, after.image)).equals(cardBefore)).toBe(false);
  });

  test("a page that saw an older version is told who saved since, and nothing changes", async ({ page, browser, baseURL }) => {
    const stale = await rsvpSettings(browser, baseURL);
    const nancy = await rsvpSettings(browser, baseURL, "nancy@example.com");
    await saveReplyBy(nancy.panel, "2026-11-25");
    await nancy.done();

    await stale.panel.getByRole("button", { name: "Close RSVPs" }).click();
    await stale.panel.getByRole("button", { name: "Yes, close RSVPs" }).click();
    await expect(
      stale.panel.getByText(/^nancy@example\.com saved a newer version at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2}\. Reload to see it\.$/),
    ).toBeVisible();
    await expect(stale.panel.getByText("Open", { exact: true })).toBeVisible();
    await stale.done();

    await page.goto("/rsvp");
    await expect(page.getByText("Please reply by 25 November").filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send my reply" })).toBeVisible();
  });

  test("Escape closes the confirm like Cancel; focus returns to the switch, or to the heading while it waits", async ({
    browser,
    baseURL,
  }) => {
    const { panel, done } = await rsvpSettings(browser, baseURL);
    const close = panel.getByRole("button", { name: "Close RSVPs" });
    await close.click();
    await expect(panel.getByRole("button", { name: "Cancel" })).toBeFocused();
    await panel.getByRole("button", { name: "Cancel" }).press("Escape");
    await expect(panel.getByRole("group")).toHaveCount(0);
    await expect(close).toBeFocused();

    await close.click();
    await panel.getByLabel("Message while closed").fill("Not saved yet");
    await panel.getByRole("button", { name: "Cancel" }).press("Escape");
    await expect(panel.getByRole("group")).toHaveCount(0);
    await expect(close).toBeDisabled();
    await expect(panel.getByRole("heading", { name: "RSVP settings" })).toBeFocused();
    await done();
  });
});
