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

// First in this file: the e2e database starts with no wishes (global setup empties it).
test("the home page's wall invites the first wish, then shows it", async ({ page }) => {
  await page.goto("/home?mode=after");
  const homeWall = page.locator("section#wishes");
  // Visible only: until the streamed wall swaps in, a hidden copy of it can sit beside it.
  await expect(homeWall.getByText("Be the first to leave a wish.").filter({ visible: true })).toBeVisible();
  await homeWall.getByRole("link", { name: "Leave a wish" }).first().click();
  await expect(page).toHaveURL(/\/wishes$/);

  await page.getByLabel("Your message to Noblet & Nancy").fill("The first wish on the home wall");
  await page.getByLabel("Sign your wish").fill("E2E First");
  await page.getByRole("button", { name: "Send my wish" }).click();
  await expect(page.getByRole("status").getByText("Thank you")).toBeVisible();

  await page.goto("/home?mode=after");
  // Visible only, as above: the hidden streamed copy can carry the same words for a moment.
  await expect(homeWall.getByText("The first wish on the home wall").filter({ visible: true })).toBeVisible();
  await expect(homeWall.getByText("Be the first to leave a wish.").filter({ visible: true })).toHaveCount(0);
});

test("a written wish is saved in Postgres and stays on the wall", async ({ page }) => {
  const message = `E2E wish ${Date.now()}`;
  await page.goto("/wishes");
  await page.getByLabel("Your message to Noblet & Nancy").fill(message);
  await page.getByLabel("Sign your wish").fill("E2E Wisher");
  await page.getByRole("button", { name: "Send my wish" }).click();
  await expect(page.getByRole("status").getByText("Thank you")).toBeVisible();

  const wall = page.locator("section[aria-labelledby='wall-h']");
  await expect(wall.getByText(message)).toBeVisible();
  await page.reload();
  await expect(wall.getByText(message)).toBeVisible();

  const sql = testDb();
  try {
    const rows = await sql`SELECT kind, signed_as FROM wishes WHERE message = ${message}`;
    expect(rows).toEqual([{ kind: "text", signed_as: "E2E Wisher" }]);
  } finally {
    await sql.end();
  }
});
