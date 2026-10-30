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
