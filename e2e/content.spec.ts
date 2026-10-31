import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

test("the home page shows content saved in the database", async ({ page }) => {
  await page.goto("/home?mode=before");
  // The page streams in: until the swap, a hidden copy of the question sits beside the visible one.
  await expect(page.getByText("E2E unique question").filter({ visible: true })).toBeVisible();
});

const BUILT_IN_RECEPTION_GPS = "AX-0084-3317";

/** A browser signed in to the admin through Cloudflare Access, allowed to read what the copy button copies. */
async function signedIn(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  return { page: await context.newPage(), done: () => context.close() };
}

/** Saves Venues → Reception → GhanaPost GPS in the admin. */
async function saveReceptionGps(page: Page, gps: string) {
  await page.goto("/admin/content/venues");
  // The form works once the page has hydrated.
  await page.waitForLoadState("networkidle");
  await page.getByRole("group", { name: "Reception" }).getByLabel("GhanaPost GPS").fill(gps);
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
      await saveReceptionGps(page, "AS-1205-2026");

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
        "Place, GPS and directions come from Venues → Reception venue: BN 111 Katakyie St, Tepa · GhanaPost GPS · AS-1205-2026",
      );
    } finally {
      // Later tests expect the built-in GPS.
      await saveReceptionGps(page, BUILT_IN_RECEPTION_GPS);
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
      await expect(form.getByLabel("Venue", { exact: true })).toHaveCount(3);
      await expect(form.getByLabel("Extra place note")).toHaveCount(3);
      await expect(form.getByLabel(/GPS/)).toHaveCount(0);
      await expect(form.getByLabel(/^Place/)).toHaveCount(0);
      await expect(form.getByLabel(/Directions/)).toHaveCount(0);

      const thanksgiving = page.getByRole("group", { name: "Thanksgiving service" });
      await expect(thanksgiving.getByLabel("Venue", { exact: true })).toHaveValue("church");
      await expect(thanksgiving).toContainText("come from Venues → Church: Assemblies of God, Victory Worship Centre, Tepa");
      // Choosing another venue shows its place straight away, before anything is saved.
      await thanksgiving.getByLabel("Venue", { exact: true }).selectOption("reception");
      await expect(thanksgiving).toContainText(
        `come from Venues → Reception venue: BN 111 Katakyie St, Tepa · GhanaPost GPS · ${BUILT_IN_RECEPTION_GPS}`,
      );
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(thanksgiving.getByLabel("Venue", { exact: true })).toHaveValue("church");
    } finally {
      await done();
    }
  });
});
