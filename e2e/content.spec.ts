import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

test("the home page shows content saved in the database", async ({ page }) => {
  await page.goto("/home?mode=before");
  // The page streams in: until the swap, a hidden copy of the question sits beside the visible one.
  await expect(page.getByText("E2E unique question").filter({ visible: true })).toBeVisible();
});

const BUILT_IN_RECEPTION_GPS = "AX-0084-3317";
const BUILT_IN_RECEPTION_NAME = "BN 111 Katakyie St";

/** A browser signed in to the admin through Cloudflare Access, allowed to read what the copy button copies. */
async function signedIn(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  return { page: await context.newPage(), done: () => context.close() };
}

/** Saves one field of Venues → Reception in the admin, such as its GhanaPost GPS. */
async function saveReceptionVenue(page: Page, label: "GhanaPost GPS" | "Name", value: string) {
  await page.goto("/admin/content/venues");
  // The form works once the page has hydrated.
  await page.waitForLoadState("networkidle");
  await page.getByRole("group", { name: "Reception" }).getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save venues" }).click();
  await expect(page.getByText("Saved. Guests see it now.")).toBeVisible();
}

test.describe("each venue fact typed once", () => {
  test("a new GhanaPost GPS for the reception venue reaches its celebration card, the map and the copy button", async ({
    browser,
    baseURL,
  }) => {
    const { page, done } = await signedIn(browser, baseURL);
    try {
      await saveReceptionVenue(page, "GhanaPost GPS", "AS-1205-2026");

      await page.goto("/home?mode=before");
      // The page streams in: until the swap, a hidden copy sits beside the visible one.
      const receptionCard = page
        .locator("#celebrations article")
        .filter({ visible: true })
        .filter({ has: page.getByRole("heading", { name: "Reception" }) });
      await expect(receptionCard).toContainText("BN 111 Katakyie St, Tepa");
      await expect(receptionCard).toContainText("GhanaPost GPS · AS-1205-2026");
      await expect(receptionCard.getByRole("link", { name: "Directions" })).toHaveAttribute(
        "href",
        "https://www.google.com/maps/dir/?api=1&destination=7.018556,-2.145472",
      );

      const map = page.locator("#map").filter({ visible: true });
      await expect(map).toContainText("GPS · AS-1205-2026");
      await expect(page.locator("body")).not.toContainText(BUILT_IN_RECEPTION_GPS);
      await map.getByRole("button", { name: "Copy GPS code for BN 111 Katakyie St" }).click();
      await expect(map.getByRole("button", { name: "GPS code for BN 111 Katakyie St copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("AS-1205-2026");

      // The celebrations editor shows where the reception's place and GPS now come from.
      await page.goto("/admin/content/celebrations");
      await expect(page.getByRole("group", { name: "Reception" })).toContainText(
        "Place, GPS and directions come from Venues → Reception: BN 111 Katakyie St, Tepa · GhanaPost GPS · AS-1205-2026",
      );
    } finally {
      // Later tests expect the built-in GPS.
      await saveReceptionVenue(page, "GhanaPost GPS", BUILT_IN_RECEPTION_GPS);
      await done();
    }
  });

  test("the celebrations editor chooses a venue rather than taking a place, GPS or directions link", async ({
    browser,
    baseURL,
  }) => {
    const { page, done } = await signedIn(browser, baseURL);
    try {
      await page.goto("/admin/content/celebrations");
      await page.waitForLoadState("networkidle");
      const form = page.locator("form.admin-form");
      await expect(form.getByLabel("Venue", { exact: true })).toHaveCount(2);
      await expect(form.getByLabel("Extra place note")).toHaveCount(2);
      await expect(form.getByLabel(/GPS/)).toHaveCount(0);
      await expect(form.getByLabel(/^Place/)).toHaveCount(0);
      await expect(form.getByLabel(/Directions/)).toHaveCount(0);

      const whiteWedding = page.getByRole("group", { name: "White wedding", exact: true });
      await expect(whiteWedding.getByLabel("Venue", { exact: true })).toHaveValue("church");
      await expect(whiteWedding).toContainText("come from Venues → Church: Assemblies of God, Victory Worship Centre, Tepa");
      // Choosing another venue shows its place straight away, before anything is saved.
      await whiteWedding.getByLabel("Venue", { exact: true }).selectOption("reception");
      await expect(whiteWedding).toContainText(
        `come from Venues → Reception: BN 111 Katakyie St, Tepa · GhanaPost GPS · ${BUILT_IN_RECEPTION_GPS}`,
      );
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(whiteWedding.getByLabel("Venue", { exact: true })).toHaveValue("church");
    } finally {
      await done();
    }
  });

  test("the order of the day takes its place from the celebration's venue: renaming the venue renames it", async ({
    browser,
    baseURL,
  }) => {
    const { page, done } = await signedIn(browser, baseURL);
    try {
      await saveReceptionVenue(page, "Name", "Katakyie Gardens");

      await page.goto("/programme");
      const reception = page.locator("section#reception");
      await expect(reception).toContainText("Katakyie Gardens, Tepa");
      await expect(reception).not.toContainText(BUILT_IN_RECEPTION_NAME);
      await expect(page.locator("section#ceremony")).toContainText("Assemblies of God, Victory Worship Centre, Tepa");
    } finally {
      // Later tests expect the built-in name.
      await saveReceptionVenue(page, "Name", BUILT_IN_RECEPTION_NAME);
      await done();
    }
  });
});

test.describe("the order of the day in the admin", () => {
  test("an item added to the reception, with a time, shows there on the Order of the day page", async ({ browser, baseURL }) => {
    const { page, done } = await signedIn(browser, baseURL);
    try {
      await page.goto("/admin/content/schedule");
      await page.waitForLoadState("networkidle");
      const reception = page.getByRole("region", { name: /^Reception/ });
      await reception.getByRole("button", { name: "Add an item to the Reception" }).click();
      const added = reception.getByRole("group", { name: "New item" });
      await added.getByLabel("Time", { exact: true }).fill("23.45");
      await added.getByLabel("Note", { exact: true }).fill("Out on the lawn");
      // Last: once it has a title, the item is named by it rather than "New item".
      await added.getByLabel("What happens", { exact: true }).fill("E2E fireworks");
      await page.getByRole("button", { name: "Save order of the day" }).click();
      await expect(page.getByText("Saved. Guests see it now.")).toBeVisible();

      await page.goto("/programme");
      const item = page.locator("section#reception li").filter({ hasText: "E2E fireworks" });
      await expect(item).toContainText("11:45 PM");
      await expect(item).toContainText("Out on the lawn");
      await expect(page.locator("section#ceremony")).not.toContainText("E2E fireworks");

      // The page's button and the header lead here.
      await page.goto("/home?mode=before");
      await page.getByRole("link", { name: "See the order of the day" }).filter({ visible: true }).click();
      await expect(page).toHaveURL(/\/programme$/);
    } finally {
      await page.goto("/admin/content/schedule");
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Remove E2E fireworks (Reception)" }).click();
      await page.getByRole("button", { name: "Save order of the day" }).click();
      await expect(page.getByText("Saved. Guests see it now.")).toBeVisible();
      await done();
    }
  });

  test("an item with no title is named where it sits when the save is refused", async ({ browser, baseURL }) => {
    const { page, done } = await signedIn(browser, baseURL);
    try {
      await page.goto("/admin/content/schedule");
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Add an item to the White wedding" }).click();
      await page.getByRole("button", { name: "Save order of the day" }).click();
      await expect(page.getByRole("status").filter({ hasText: "1 problem to fix: White wedding · New item · What happens" })).toBeVisible();
      await expect(page.getByRole("region", { name: /^White wedding/ }).getByRole("group", { name: "New item" }).getByText("Cannot be empty")).toBeVisible();
    } finally {
      await done();
    }
  });
});
