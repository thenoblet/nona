import { randomBytes } from "node:crypto";
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

test("a personal link brings a guest to another phone", async ({ browser, baseURL }) => {
  const firstPhone = await browser.newContext({ baseURL });
  const secondPhone = await browser.newContext({ baseURL });
  const sql = testDb();
  try {
    const created = await firstPhone.request.post("/api/guest", { data: { displayName: "E2E Linked Guest" } });
    expect(created.status()).toBe(200);
    expect(created.headers()["cache-control"]).toBe("private, no-store");
    const { guestId } = await created.json();

    // The production server's cookie: signed, httpOnly, Secure, Lax, for the whole site, for two years.
    const setCookie = created.headers()["set-cookie"];
    expect(setCookie).toMatch(/^nona_guest=[0-9a-f-]{36}(%2C[0-9a-f-]{36})*\.[A-Za-z0-9_-]{43};/);
    for (const flag of [/; HttpOnly/i, /; Secure/i, /; SameSite=Lax/i, /; Path=\//, /; Max-Age=63072000/]) {
      expect(setCookie).toMatch(flag);
    }
    const [cookie] = (await firstPhone.cookies()).filter((stored) => stored.name === "nona_guest");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });

    // The same phone asking again is the same guest.
    expect((await (await firstPhone.request.post("/api/guest", { data: {} })).json()).guestId).toBe(guestId);

    const [{ link_token: token }] = await sql`SELECT link_token FROM guests WHERE id = ${guestId}`;
    const redirect = await secondPhone.request.get(`/my/${token}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()["location"]).toBe("/album?view=mine");
    expect(redirect.headers()["cache-control"]).toBe("private, no-store");

    // Opened in the second phone's browser, the link lands on its uploads, and that phone is now the guest.
    const page = await secondPhone.newPage();
    await page.goto(`/my/${token}`);
    await expect(page).toHaveURL(/\/album\?view=mine$/);
    expect((await (await secondPhone.request.post("/api/guest", { data: {} })).json()).guestId).toBe(guestId);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM guests WHERE display_name = 'E2E Linked Guest'`;
    expect(count).toBe(1);
  } finally {
    await sql.end();
    await firstPhone.close();
    await secondPhone.close();
  }
});

test("an unknown personal link opens the album and sets no cookie", async ({ browser, baseURL }) => {
  const phone = await browser.newContext({ baseURL });
  try {
    const response = await phone.request.get(`/my/${randomBytes(32).toString("base64url")}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/album");
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await phone.cookies()).toEqual([]);
  } finally {
    await phone.close();
  }
});
