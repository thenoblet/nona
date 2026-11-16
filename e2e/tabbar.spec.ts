import { expect, test, type Browser, type Page } from "@playwright/test";

// Phones get a tab bar with the places guests need most, like an app; laptops keep the header's
// links (Noblet, 16 Nov). The music pill floats above it and can be tucked into a round button.

const phone = (browser: Browser, baseURL: string | undefined) =>
  browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const bar = (page: Page) => page.getByRole("navigation", { name: "Quick links" });

/** Where the bar's top edge is, and the lowest edge of everything the page shows above it. */
async function pageEndAndBarTop(page: Page): Promise<{ pageEnd: number; barTop: number }> {
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  return page.evaluate(() => {
    const flowing = [...document.body.children].filter(
      (element) => element instanceof HTMLElement && getComputedStyle(element).position !== "fixed" && element.checkVisibility(),
    );
    const barTop = document.querySelector("nav[aria-label='Quick links']")!.getBoundingClientRect().top;
    return { pageEnd: Math.max(...flowing.map((element) => element.getBoundingClientRect().bottom)), barTop };
  });
}

test("phones get a tab bar that follows the wedding, and laptops keep the header", async ({ browser, baseURL }) => {
  const context = await phone(browser, baseURL);
  const page = await context.newPage();

  await page.goto("/home?mode=before");
  await expect(bar(page).getByRole("link")).toHaveText(["Home", "Programme", "RSVP", "Stay", "Album"]);
  await expect(bar(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  // The bar's raised RSVP does the header's orange button's job on phones.
  await expect(page.getByRole("banner").getByRole("link", { name: "RSVP" })).toBeHidden();

  await page.goto("/home?mode=day");
  await expect(bar(page).getByRole("link")).toHaveText(["Today", "Programme", "Share", "Album", "Map"]);
  // Share and Map jump to a place on a page, so neither is ever the page you are on.
  await expect(bar(page).locator("[aria-current]")).toHaveCount(0);
  await bar(page).getByRole("link", { name: "Share" }).click();
  await expect(page).toHaveURL(/\/album#share$/);
  await expect(page.locator("#share")).toBeInViewport();

  await page.goto("/home?mode=after");
  await expect(bar(page).getByRole("link")).toHaveText(["Home", "Relive", "Wishes"]);

  await page.goto("/home?mode=before");
  await bar(page).getByRole("link", { name: "Programme" }).click();
  await expect(page).toHaveURL(/\/programme$/);
  await expect(bar(page).getByRole("link", { name: "Programme" })).toHaveAttribute("aria-current", "page");
  await page.goto("/rsvp");
  await expect(bar(page).getByRole("link", { name: "RSVP" })).toHaveAttribute("aria-current", "page");

  // Nothing hides behind the bar: scrolled to the end, the page stops above it.
  for (const path of ["/home", "/stay", "/programme"]) {
    await page.goto(path);
    await expect(bar(page).getByRole("link", { name: "Home" })).toBeVisible();
    const { pageEnd, barTop } = await pageEndAndBarTop(page);
    expect(pageEnd, path).toBeLessThanOrEqual(barTop + 1);
  }

  // Typing: the bar steps aside so it never sits on the keyboard, and comes back after.
  await page.goto("/rsvp");
  await expect(bar(page).getByRole("link", { name: "RSVP" })).toBeVisible();
  // Where the bar's top edge is, from the top of the screen (844 px tall): the bar is 64 px.
  const barTop = async () => (await bar(page).boundingBox())?.y ?? -1;
  await expect.poll(barTop).toBe(780);
  await page.getByLabel("Your full name").focus();
  await expect.poll(barTop).toBeGreaterThanOrEqual(844);
  await page.getByLabel("Your full name").blur();
  await expect.poll(barTop).toBe(780);
  await context.close();

  const laptop = await browser.newPage({ baseURL, viewport: { width: 1280, height: 800 } });
  await laptop.goto("/home");
  await expect(laptop.getByRole("banner").getByRole("link", { name: "RSVP" })).toBeVisible();
  await expect(bar(laptop)).toBeHidden();
  await laptop.close();
});

/**
 * Whether the music shows as the round button (tucked) or the pill. The other one stays in the page,
 * faded out and `inert`: out of reach of taps, keys and screen readers. Playwright's role queries
 * don't reliably leave inert elements out, and count a faded one as visible, so this checks both
 * attributes directly.
 */
async function expectTucked(page: Page, tucked: boolean) {
  const pill = page.locator("[data-music-player] > div:has(> [aria-label$=' our song'])");
  const roundButton = page.locator("[data-music-player] > button");
  const [hidden, shown] = tucked ? [pill, roundButton] : [roundButton, pill];
  await expect(hidden).toHaveAttribute("inert", "");
  await expect(hidden).toHaveCSS("opacity", "0");
  await expect(shown).not.toHaveAttribute("inert");
  await expect(shown).toHaveCSS("opacity", "1");
}

test("the music pill tucks into a round button, stays tucked across pages, and opens again", async ({ browser, baseURL }) => {
  const context = await phone(browser, baseURL);
  const page = await context.newPage();
  await page.goto("/home");
  const roundButton = page.getByRole("button", { name: /^Open the music player/ });

  await expectTucked(page, false);
  await page.getByRole("button", { name: "Make the music player smaller" }).click();
  await expectTucked(page, true);
  await expect(roundButton).toBeFocused();
  // The note is for eyes; the round button's own name says the same to a screen reader.
  await expect(page.locator("[data-music-player] p", { hasText: /Tap here to open/ })).toHaveCSS("opacity", "1");

  // The player lives in the layout, so another page keeps it tucked; so does coming back later.
  await bar(page).getByRole("link", { name: "Programme" }).click();
  await expect(page).toHaveURL(/\/programme$/);
  await expectTucked(page, true);
  await page.reload();
  await expectTucked(page, true);

  await roundButton.click();
  await expectTucked(page, false);
  await expect(page.locator("[aria-label='Play our song']")).toBeFocused();
  await page.reload();
  await expectTucked(page, false);
  await context.close();
});
