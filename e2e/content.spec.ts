import { expect, test } from "@playwright/test";

test("the home page shows content saved in the database", async ({ page }) => {
  await page.goto("/home?mode=before");
  // The page streams in: until the swap, a hidden copy of the question sits beside the visible one.
  await expect(page.getByText("E2E unique question").filter({ visible: true })).toBeVisible();
});
