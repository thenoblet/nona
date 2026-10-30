import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { TEST_DB_ENV } from "../test/env";

test("a guest can send a reply and it is saved", async ({ page }) => {
  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Guest");
  await page.getByLabel("Phone or WhatsApp").fill("0244000111");
  await page.getByLabel("Email").fill("e2e-guest@example.com");
  await page
    .getByRole("radiogroup", { name: /white wedding/i })
    .getByText("Joyfully accept")
    .click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

  const sql = postgres({
    host: TEST_DB_ENV.POSTGRES_HOST,
    port: Number(TEST_DB_ENV.POSTGRES_PORT),
    database: TEST_DB_ENV.POSTGRES_DB,
    user: TEST_DB_ENV.POSTGRES_USER,
    password: TEST_DB_ENV.POSTGRES_PASSWORD,
    max: 1,
  });
  try {
    const rows = await sql`SELECT full_name FROM rsvps WHERE email = 'e2e-guest@example.com'`;
    expect(rows).toHaveLength(1);
  } finally {
    await sql.end();
  }
});
