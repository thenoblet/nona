import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";
import { rsvp as builtInRsvp } from "../src/content/wedding";
import { TEST_DB_ENV } from "../test/env";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

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
 * At the end of the page, how far the last line of the closed message's section sits above the
 * floating music pill (negative when the pill covers it), or null when no pill is beneath it.
 */
async function signatureClearance(page: Page): Promise<number | null> {
  await page.getByText("Play our song").waitFor();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  return page.evaluate(() => {
    const signature = [...document.querySelectorAll("section[aria-label='Replies have closed'] p")].at(-1)!.getBoundingClientRect();
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
    expect(await repliesFrom("e2e-too-late@example.com")).toBe(0);

    await page.goto("/rsvp");
    await expect(page.getByText(builtInRsvp.closedMessage).filter({ visible: true })).toBeVisible();
    // Line breaks the couple type into the message are kept.
    await expect(page.getByText(builtInRsvp.closedMessage).filter({ visible: true })).toHaveCSS("white-space", "pre-line");
    await expect(page.getByRole("button", { name: "Send my reply" })).toHaveCount(0);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Replies have closed.");
    // On a phone, scrolled to the end, the signature clears the floating music pill.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await signatureClearance(page)).toBeGreaterThan(0);
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
