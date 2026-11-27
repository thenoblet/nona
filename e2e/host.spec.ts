import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

// The MC isn't one of the bridal party, so he has his own card under the wedding party on the home
// page, and the reception says who hosts it in the order of the day.

/** The MC's card as shown: the page streams in, and until the swap a hidden copy can sit beside it. */
const hostCard = (page: Page) =>
  page.locator("div.paper-card", { hasText: "Your host for the day" }).filter({ visible: true });

/** The reception's "Hosted by" line in the order of the day. */
const hostedBy = (page: Page) => page.locator("#reception").getByText(/^Hosted by/).filter({ visible: true });

test("guests meet the MC under the wedding party, and see him host the reception", async ({ page }) => {
  await page.goto("/home?mode=before");
  const card = hostCard(page);
  await expect(card).toContainText("International MC");
  await expect(card).toContainText("Master of ceremonies");
  await expect(card.getByRole("img", { name: "International MC with a microphone" })).toBeVisible();

  await page.goto("/programme");
  await expect(hostedBy(page)).toHaveText("Hosted by International MC");
  // Only the reception: the white wedding has no MC.
  await expect(page.locator("#ceremony").getByText(/^Hosted by/)).toHaveCount(0);
});

async function signedIn(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
  return { page: await context.newPage(), done: () => context.close() };
}

async function saveHost(page: Page, change: (form: Page) => Promise<void>) {
  await page.goto("/admin/content/mc");
  await page.waitForLoadState("networkidle");
  await change(page);
  await page.getByRole("button", { name: "Save MC" }).click();
  await expect(page.getByText("Saved. Guests see it now.")).toBeVisible();
}

test("the couple rename the MC or hide him in the admin, and guests see the change", async ({ browser, baseURL }) => {
  const { page, done } = await signedIn(browser, baseURL);
  try {
    await saveHost(page, async (form) => {
      await form.getByLabel("Name", { exact: true }).fill("MC E2E Kojo");
      await form.getByLabel("What he does").fill("Keeps the reception moving");
    });
    await page.goto("/home?mode=before");
    await expect(hostCard(page)).toContainText("MC E2E Kojo");
    await expect(hostCard(page)).toContainText("Keeps the reception moving");
    await page.goto("/programme");
    await expect(hostedBy(page)).toHaveText("Hosted by MC E2E Kojo");

    await saveHost(page, (form) => form.getByLabel("Hide him from the site").check());
    await page.goto("/home?mode=before");
    await expect(page.getByRole("heading", { name: "The wedding party" })).toBeVisible();
    await expect(page.getByText("Your host for the day")).toHaveCount(0);
    await page.goto("/programme");
    await expect(page.locator("#reception").getByRole("heading")).toBeVisible();
    await expect(page.getByText(/^Hosted by/)).toHaveCount(0);
  } finally {
    // Later tests expect the built-in MC.
    await saveHost(page, async (form) => {
      await form.getByLabel("Name", { exact: true }).fill("International MC");
      await form.getByLabel("What he does").fill("He will guide you through the reception and let you know what comes next.");
      await form.getByLabel("Hide him from the site").uncheck();
    });
    await done();
  }
});
