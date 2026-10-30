import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { TEST_DB_ENV } from "../test/env";

function testDb() {
  return postgres({
    host: TEST_DB_ENV.POSTGRES_HOST,
    port: Number(TEST_DB_ENV.POSTGRES_PORT),
    database: TEST_DB_ENV.POSTGRES_DB,
    user: TEST_DB_ENV.POSTGRES_USER,
    password: TEST_DB_ENV.POSTGRES_PASSWORD,
    max: 1,
    connect_timeout: 5,
  });
}

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

  const sql = testDb();
  try {
    const rows = await sql`SELECT full_name FROM rsvps WHERE email = 'e2e-guest@example.com'`;
    expect(rows).toHaveLength(1);
  } finally {
    await sql.end();
  }
});

test("a second reply is kept beside the first, and the guest is told nothing about the first", async ({ page }) => {
  await page.goto("/rsvp");
  await page.getByLabel("Your full name").fill("E2E Second Reply");
  await page.getByLabel("Phone or WhatsApp").fill("0244000333");
  await page.getByLabel("Email").fill("e2e-second-reply@example.com");
  await page.getByRole("radiogroup", { name: /white wedding/i }).getByText("Joyfully accept").click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  const thankYou = page.locator("section[aria-labelledby='sent-h']");
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  const firstScreen = await thankYou.innerText();

  await page.getByRole("button", { name: "Change my reply" }).click();
  await page.getByLabel("Phone or WhatsApp").fill("+233 24 400 0333");
  await page.getByLabel("How many in your party?").selectOption("2 people");
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

  // The same thank-you as the first time: nothing says an earlier reply was found.
  expect(await thankYou.innerText()).toBe(firstScreen);

  const sql = testDb();
  try {
    const rows = await sql`
      SELECT superseded_at FROM rsvps WHERE email = 'e2e-second-reply@example.com' ORDER BY received_at
    `;
    expect(rows.map((row) => row.superseded_at)).toEqual([null, null]);
  } finally {
    await sql.end();
  }
});
