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

  // The controls hide after three seconds without a move, and on a slow machine they can hide
  // before the click, which then lands on the photo's tap area. The operator's mouse reaches the
  // button first, waking them: so does this one, and it tries again until the click lands. Each
  // try moves to a new point, so the browser sends a move. A click that times out was never sent.
  const controls = page.getByRole("group", { name: "Slideshow controls" });
  const button = await fullScreen.boundingBox();
  if (!button) throw new Error("The Full screen button has no size");
  let nudge = 0;
  await expect(async () => {
    nudge = 1 - nudge;
    await page.mouse.move(button.x + button.width / 2 + nudge, button.y + button.height / 2);
    await fullScreen.click({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.waitForTimeout(4000);
  await expect(controls).toHaveCSS("opacity", "0", { timeout: 1000 });

  // A click on the right of the photo moves on; space then pauses, and nothing moves after that.
  await page.mouse.click(1250, 540);
  const photo = await currentPhoto(page);
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Play the slideshow" })).toHaveCount(1);
  await page.waitForTimeout(8000); // longer than a photo's six seconds
  expect(await currentPhoto(page)).toBe(photo);
});
