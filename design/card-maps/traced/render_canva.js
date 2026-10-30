const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  for (const name of ['first', 'premium', 'quiet', 'deco', 'ashanti', 'water']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
    await page.goto('file://' + __dirname + '/canva-' + name + '.html');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.locator('.map').screenshot({ path: __dirname + '/tepa-map-' + name + '.png', omitBackground: true });
    await page.close();
  }
  await browser.close();
})();
