import { expect, test } from "@playwright/test";

// The e2e server is a production build with no Cloudflare Access settings, like a request that
// reaches the origin without passing Access: the admin must hand out nothing.
test("without Cloudflare Access the admin shows no replies and refuses the CSV", async ({ page, request }) => {
  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Admin Check");
  await page.getByLabel("Phone or WhatsApp").fill("0244000222");
  await page.getByLabel("Email").fill("e2e-admin-check@example.com");
  await page
    .getByRole("radiogroup", { name: /white wedding/i })
    .getByText("Joyfully accept")
    .click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

  const replies = await request.get("/admin/rsvps");
  const html = await replies.text();
  expect(html).toContain("This page is for the couple.");
  expect(html).not.toContain("E2E Admin Check");
  expect(html).not.toContain("e2e-admin-check@example.com");

  const csv = await request.get("/admin/rsvps.csv");
  expect(csv.status()).toBe(403);
  expect(csv.headers()["cache-control"]).toBe("private, no-store");
  expect(await csv.text()).not.toContain("E2E Admin Check");

  const admin = await request.get("/admin", { maxRedirects: 0 });
  expect(admin.status()).toBe(307);
  expect(admin.headers()["location"]).toBe("/admin/rsvps");
});

test("without Cloudflare Access the site text pages show only their shell", async ({ request }) => {
  const content = await request.get("/admin/content", { maxRedirects: 0 });
  expect(content.status()).toBe(307);
  expect(content.headers()["location"]).toBe("/admin/content/celebrations");

  // Global setup saved a question; neither it nor the built-in text reaches the page.
  const faq = await (await request.get("/admin/content/faq")).text();
  expect(faq).toContain("This page is for the couple.");
  expect(faq).toContain("Questions");
  expect(faq).not.toContain("E2E unique question");
  expect(faq).not.toContain("Can I bring a plus-one?");

  const celebrations = await (await request.get("/admin/content/celebrations")).text();
  expect(celebrations).toContain("This page is for the couple.");
  expect(celebrations).not.toContain("Evening glamour");
  expect(celebrations).not.toContain("Formal · black tie optional");

  // An unknown section gets notFound(). Its page streams after the admin's static top bar, so, as
  // Next documents for streamed pages, the status stays 200 and the not-found page says noindex.
  const unknown = await (await request.get("/admin/content/not-a-section")).text();
  expect(unknown).toContain("This page could not be found.");
  expect(unknown).toContain('<meta name="robots" content="noindex"/>');
  expect(unknown).not.toContain("This page is for the couple.");
});
