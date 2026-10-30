import { expect, test, type Page } from "@playwright/test";

// The venue TV runs all evening with nobody at it. The operator clicks Full screen (README) and
// maybe the photo, then walks away: nothing a click leaves behind may stay on screen or turn the
// space bar into something other than pause.
test.use({ viewport: { width: 1920, height: 1080 } });

const currentPhoto = (page: Page) => page.locator('section [aria-hidden="false"] img:not([alt=""])').getAttribute("alt");

test("the TV controls fade after the full-screen click, and space after a click on the photo pauses", async ({ page }) => {
  await page.goto("/slideshow");
  // Only drawn once the page's script runs, so the clicks below are handled.
  const fullScreen = page.getByRole("button", { name: "Full screen" });
  await expect(fullScreen).toBeVisible();

  await fullScreen.click();
  await page.waitForTimeout(4000);
  await expect(page.getByRole("group", { name: "Slideshow controls" })).toHaveCSS("opacity", "0", { timeout: 1000 });

  // A click on the right of the photo moves on; space then pauses, and nothing moves after that.
  await page.mouse.click(1250, 540);
  const photo = await currentPhoto(page);
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Play the slideshow" })).toHaveCount(1);
  await page.waitForTimeout(8000); // longer than a photo's six seconds
  expect(await currentPhoto(page)).toBe(photo);
});
