import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

// Noblet and Nancy won't have their phones on the day, so guests see whom to call for help: on
// Today, on the home page under Travel & stay, and on the RSVP thank-you for a guest who is coming.

const BUILT_IN = [
  { name: "Daniel Afriyie", phone: "055 936 8495", tel: "tel:+233559368495", whatsapp: "https://wa.me/233559368495" },
  { name: "Edward Asamoah", phone: "024 417 3796", tel: "tel:+233244173796", whatsapp: "https://wa.me/233244173796" },
  { name: "Prince Brobbey", phone: "055 151 9910", tel: "tel:+233551519910", whatsapp: "https://wa.me/233551519910" },
];

/** The help card as shown: the page streams in, and until the swap a hidden copy sits beside it. */
const helpCard = (page: Page) => page.locator("#help").filter({ visible: true });

test("guests see whom to call on the home page and on Today, with Call and WhatsApp for each", async ({ page }) => {
  await page.goto("/home?mode=before");
  const card = helpCard(page);
  await expect(card.getByRole("heading", { name: "Need a hand getting here?" })).toBeVisible();
  for (const helper of BUILT_IN) {
    await expect(card.getByRole("link", { name: `Call ${helper.name}, ${helper.phone}` })).toHaveAttribute("href", helper.tel);
    await expect(card.getByRole("link", { name: `WhatsApp ${helper.name}` })).toHaveAttribute("href", helper.whatsapp);
  }

  await page.goto("/today?mode=day");
  await expect(helpCard(page).getByRole("heading", { name: "Need a hand today?" })).toBeVisible();
  await page.getByRole("link", { name: "Lost or need help? Call us" }).click();
  await expect(helpCard(page)).toBeInViewport();
});

test("the RSVP thank-you shows whom to call to a guest who is coming, and not to one who isn't", async ({ page }) => {
  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Help Coming");
  await page.getByLabel("Phone or WhatsApp").fill("0244000771");
  await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  await expect(helpCard(page).getByRole("heading", { name: "Need a hand getting here?" })).toBeVisible();
  await expect(helpCard(page).getByRole("link", { name: /^Call Daniel Afriyie/ })).toBeVisible();

  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Help Away");
  await page.getByLabel("Phone or WhatsApp").fill("0244000772");
  await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Regretfully decline").click();
  await page.getByRole("radiogroup", { name: /reception/i }).getByText("Regretfully decline").click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  await expect(page.locator("#help")).toHaveCount(0);
});

async function signedIn(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
  return { page: await context.newPage(), done: () => context.close() };
}

test("the couple add and remove helpers in the admin, and guests see the change", async ({ browser, baseURL }) => {
  const { page, done } = await signedIn(browser, baseURL);
  try {
    await page.goto("/admin/content/help");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add a helper" }).click();
    // The new helper is last; its group takes the name once typed.
    await page.getByLabel("Name", { exact: true }).last().fill("Esi E2E Helper");
    const added = page.getByRole("group", { name: "Esi E2E Helper" });
    await added.getByLabel("Phone", { exact: true }).fill("020 123 4567");
    await added.getByLabel("What they help with").fill("Parking at the church");
    await page.getByRole("button", { name: "Save help on the day" }).click();
    await expect(page.getByText("Saved. Guests see it now.")).toBeVisible();

    await page.goto("/home?mode=before");
    const card = helpCard(page);
    await expect(card).toContainText("Esi E2E Helper");
    await expect(card).toContainText("Parking at the church");
    await expect(card.getByRole("link", { name: "Call Esi E2E Helper, 020 123 4567" })).toHaveAttribute("href", "tel:+233201234567");
  } finally {
    // Later tests expect the three built-in helpers.
    await page.goto("/admin/content/help");
    await page.waitForLoadState("networkidle");
    const extra = page.getByRole("button", { name: "Remove Esi E2E Helper" });
    if (await extra.count()) {
      await extra.click();
      await page.getByRole("button", { name: "Save help on the day" }).click();
      await expect(page.getByText("Saved. Guests see it now.")).toBeVisible();
    }
    await done();
  }
});
