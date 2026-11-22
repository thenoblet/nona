import { expect, test, type Browser } from "@playwright/test";
import { ACCESS_HEADER, accessToken } from "./cloudflare-access";

// The admin's Emails page: the last emails to everyone who replied, once replies close. The tests
// have no Resend key, so emails stay on their way; what's checked is who they go to.

async function as(browser: Browser, baseURL: string | undefined, email?: string) {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: await accessToken(email ? { email } : undefined) },
  });
  return { page: await context.newPage(), done: () => context.close() };
}

test("the couple send the final details to guests coming, and WhatsApp those without an email", async ({ browser, baseURL, page: guest }) => {
  // Two guests coming: one with an email, one without.
  for (const [name, phone, email] of [
    ["E2E Final Email", "0244000881", "e2e-final@example.com"],
    ["E2E Final WhatsApp", "0244000882", ""],
  ]) {
    await guest.goto("/rsvp");
    await guest.getByLabel("Your full name").fill(name);
    await guest.getByLabel("Phone or WhatsApp").fill(phone);
    if (email) await guest.getByLabel("Email").fill(email);
    await guest.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
    await guest.getByRole("button", { name: "Send my reply" }).click();
    await expect(guest.getByRole("heading", { name: "Thank you" })).toBeVisible();
  }

  const { page, done } = await as(browser, baseURL);
  try {
    await page.goto("/admin/emails");
    await page.waitForLoadState("networkidle");
    const details = page.getByRole("region", { name: "Final details email" });
    await expect(details.locator("iframe")).toHaveAttribute("src", "/admin/emails/preview?kind=details");
    const preview = await page.request.get("/admin/emails/preview?kind=details");
    expect(await preview.text()).toContain("Need a hand on the day?");

    await details.getByRole("button", { name: "Send a test to me" }).click();
    await expect(details.getByRole("status")).toContainText("Sending a test to");

    const send = details.getByRole("button", { name: /^Send to \d+ guests?$/ });
    const count = Number((await send.textContent())?.match(/\d+/)?.[0]);
    expect(count).toBeGreaterThan(0);
    await send.click();
    await details.getByRole("button", { name: `Yes, send to ${count} guest${count === 1 ? "" : "s"}` }).click();
    await expect(details.getByRole("status")).toHaveText(`Sending to ${count} guest${count === 1 ? "" : "s"}.`);
    // Pressing Send again sends to nobody new.
    await expect(details.getByRole("button", { name: "Everyone has had it" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Sent before" })).toContainText(`Final details · ${count} guest`);

    const noEmail = page.getByRole("region", { name: /^Coming, with no email/ });
    const whatsapp = noEmail.getByRole("link", { name: /to E2E Final WhatsApp/ });
    const href = decodeURIComponent((await whatsapp.getAttribute("href")) ?? "");
    expect(href.startsWith("https://wa.me/233244000882?text=Dear E2E Final WhatsApp,")).toBe(true);
    expect(href).toContain("Daniel Afriyie: 055 936 8495");
    const tick = noEmail.getByRole("checkbox", { name: "Sent to E2E Final WhatsApp" });
    await tick.check();
    await page.reload();
    await expect(page.getByRole("region", { name: /^Coming, with no email/ }).getByRole("checkbox", { name: "Sent to E2E Final WhatsApp" })).toBeChecked();
  } finally {
    await done();
  }
});

test("a viewer is sent back to Replies from the Emails page, and can't read the preview", async ({ browser, baseURL }) => {
  const couple = await as(browser, baseURL);
  try {
    await couple.page.goto("/admin/people");
    await couple.page.waitForLoadState("networkidle");
    await couple.page.getByLabel("Their email").fill("e2e-emails-viewer@example.com");
    await couple.page.getByRole("button", { name: "Add viewer" }).click();
    await expect(couple.page.getByRole("button", { name: "Remove e2e-emails-viewer@example.com" })).toBeVisible();

    const viewer = await as(browser, baseURL, "e2e-emails-viewer@example.com");
    try {
      await viewer.page.goto("/admin/emails");
      await expect(viewer.page).toHaveURL(/\/admin\/rsvps$/);
      const preview = await viewer.page.request.get("/admin/emails/preview?kind=details");
      expect(preview.status()).toBe(403);
    } finally {
      await viewer.done();
    }
  } finally {
    await couple.page.getByRole("button", { name: "Remove e2e-emails-viewer@example.com" }).click();
    await couple.page.getByRole("button", { name: "Yes, remove" }).click();
    await couple.done();
  }
});
