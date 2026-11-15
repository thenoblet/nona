import { expect, test } from "@playwright/test";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

// The e2e server is a production build that checks Cloudflare Access tokens against a local key
// server (cloudflare-access.ts). A request without a token is like one that reaches the origin
// without passing Access: the admin must hand out nothing.
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

  const excel = await request.get("/admin/rsvps.xlsx");
  expect(excel.status()).toBe(403);
  expect(excel.headers()["cache-control"]).toBe("private, no-store");
  expect(await excel.text()).not.toContain("E2E Admin Check");

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

test("a Cloudflare Access token for another application is refused like none at all", async ({ request }) => {
  const otherApplication = { [ACCESS_HEADER]: await accessToken({ audience: "another-application" }) };
  const refused = await (await request.get("/admin/rsvps", { headers: otherApplication })).text();
  expect(refused).toContain("This page is for the couple.");
  expect(refused).not.toContain("RSVP settings");
  const csv = await request.get("/admin/rsvps.csv", { headers: otherApplication });
  expect(csv.status()).toBe(403);

  // The same request with this application's token gets in, so the refusal is the audience's doing.
  const signedIn = { [ACCESS_HEADER]: await accessToken() };
  const replies = await (await request.get("/admin/rsvps", { headers: signedIn })).text();
  expect(replies).toContain("RSVP settings");
  expect(replies).not.toContain("This page is for the couple.");
  expect((await request.get("/admin/rsvps.csv", { headers: signedIn })).status()).toBe(200);
  expect((await request.get("/admin/rsvps.xlsx", { headers: otherApplication })).status()).toBe(403);
  expect((await request.get("/admin/rsvps.xlsx", { headers: signedIn })).status()).toBe(200);
});

test("a viewer the couple add reads and downloads the Replies list, changes nothing, and loses access when removed", async ({ browser, baseURL }) => {
  const viewerEmail = "e2e-viewer@example.com";
  const couple = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken() } });
  const viewer = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken({ email: viewerEmail }) } });
  try {
    // Before the couple add them, Access letting them through is not enough.
    const viewerPage = await viewer.newPage();
    await viewerPage.goto("/admin/rsvps");
    await expect(viewerPage.getByText("This page is for the couple.")).toBeVisible();

    const couplePage = await couple.newPage();
    await couplePage.goto("/admin/people");
    await couplePage.waitForLoadState("networkidle");
    await couplePage.getByLabel("Their email").fill("E2E-Viewer@example.com");
    await couplePage.getByRole("button", { name: "Add viewer" }).click();
    await expect(couplePage.getByRole("status").filter({ hasText: `Added ${viewerEmail}` })).toBeVisible();
    await expect(couplePage.getByRole("listitem").filter({ hasText: viewerEmail })).toContainText("by couple@example.com");

    // The viewer's Replies: the list and the downloads, marked View only, with nothing that changes it.
    await viewerPage.goto("/admin/rsvps");
    await expect(viewerPage.getByRole("heading", { name: "Replies", level: 1 })).toBeVisible();
    await expect(viewerPage.getByText("View only")).toBeVisible();
    const tabs = viewerPage.getByRole("navigation", { name: "Admin sections" }).getByRole("link");
    await expect(tabs).toHaveText(["Replies"]);
    await expect(viewerPage.getByRole("region", { name: "RSVP settings" })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: /^Delete / })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: /^Keep / })).toHaveCount(0);
    expect((await viewer.request.get("/admin/rsvps.csv")).status()).toBe(200);
    expect((await viewer.request.get("/admin/rsvps.xlsx")).status()).toBe(200);

    // Every other part of the admin sends them back to Replies.
    for (const path of ["/admin/photos", "/admin/content/faq", "/admin/photos/site", "/admin/people"]) {
      await viewerPage.goto(path);
      await expect(viewerPage).toHaveURL(/\/admin\/rsvps$/);
    }

    // Removed, they are refused again.
    await couplePage.goto("/admin/people");
    await couplePage.waitForLoadState("networkidle");
    await couplePage.getByRole("button", { name: `Remove ${viewerEmail}` }).click();
    await couplePage.getByRole("button", { name: "Yes, remove" }).click();
    await expect(couplePage.getByRole("status").filter({ hasText: "Removed" })).toBeVisible();
    await viewerPage.goto("/admin/rsvps");
    await expect(viewerPage.getByText("This page is for the couple.")).toBeVisible();
    expect((await viewer.request.get("/admin/rsvps.csv")).status()).toBe(403);
  } finally {
    await couple.close();
    await viewer.close();
  }
});
