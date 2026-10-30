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
async function rsvpSettings(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
  const page = await context.newPage();
  await page.goto("/admin/rsvps");
  // The panel works once the page has hydrated.
  await page.waitForLoadState("networkidle");
  return { panel: page.getByRole("region", { name: "RSVP settings" }), done: () => context.close() };
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

/**
 * The link-preview tags WhatsApp's crawler reads: the <head> of the first HTML, which it reads
 * without running scripts, so tags streamed in later would never reach it.
 */
async function previewTags(request: APIRequestContext, path: string) {
  const html = await (await request.get(path, { headers: { "user-agent": "WhatsApp/2.23.20.0" } })).text();
  const head = html.slice(0, html.indexOf("</head>"));
  const tag = (property: string) => new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(head)?.[1];
  return { description: tag("og:description"), image: tag("og:image") };
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

    const { panel, done } = await rsvpSettings(browser, baseURL);
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
    await done();

    // The page opened before the close still has its form: the reply is refused with the message.
    await page.getByRole("button", { name: "Send my reply" }).click();
    await expect(page.getByText(builtInRsvp.closedMessage)).toBeVisible();
    expect(await repliesFrom("e2e-too-late@example.com")).toBe(0);

    await page.goto("/rsvp");
    await expect(page.getByText(builtInRsvp.closedMessage).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send my reply" })).toHaveCount(0);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Replies have closed.");

    await page.goto("/home?mode=before");
    // The home page streams in: until the swap, a hidden copy sits beside the visible one.
    const replySection = page.locator("section#rsvp").filter({ visible: true });
    await expect(replySection.getByRole("heading", { name: "Replies have closed" })).toBeVisible();
    await expect(replySection.getByText(builtInRsvp.closedMessage)).toBeVisible();
    await expect(replySection.getByRole("link", { name: "Respond now" })).toHaveCount(0);
    await expect(page.getByLabel("Your invitation").filter({ visible: true }).getByText("Replies have closed")).toBeVisible();

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

    // WhatsApp's crawler gets the new date in the <head> of the first HTML.
    expect((await previewTags(request, "/")).description).toMatch(/Kindly reply by 27 November\.$/);
    const after = await previewTags(request, "/rsvp");
    expect(after.description).toContain("Please reply by 27 November;");
    expect((await previewImage(request, after.image)).equals(cardBefore)).toBe(false);
  });
});
