import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import postgres from "postgres";
import { TEST_DB_ENV } from "../test/env";

// The e2e server is a production build, so the cookie carries the __Host- prefix.
const COOKIE = "__Host-nona_guest";

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

/** Makes the phone's own guest through the API, as the uploader does, and returns its id and link token. */
async function makeGuest(request: APIRequestContext, displayName: string): Promise<{ guestId: string; token: string }> {
  const response = await request.post("/api/guest", { data: { displayName } });
  expect(response.status()).toBe(200);
  const { guestId } = await response.json();
  const sql = testDb();
  try {
    const [{ link_token: token }] = await sql`SELECT link_token FROM guests WHERE id = ${guestId}`;
    return { guestId, token };
  } finally {
    await sql.end();
  }
}

async function ownGuestOf(phone: BrowserContext): Promise<string> {
  return (await (await phone.request.post("/api/guest", { data: {} })).json()).guestId;
}

/** The guest ids in the phone's cookie, its own first. */
async function cookieIds(phone: BrowserContext): Promise<string[]> {
  const [cookie] = (await phone.cookies()).filter((stored) => stored.name === COOKIE);
  return decodeURIComponent(cookie.value).split(".")[0].split(",");
}

test("the guest cookie is signed, httpOnly, Secure, Lax, __Host- and kept for two years", async ({ browser, baseURL }) => {
  const phone = await browser.newContext({ baseURL });
  try {
    const created = await phone.request.post("/api/guest", { data: { displayName: "E2E Cookie Guest" } });
    expect(created.status()).toBe(200);
    expect(created.headers()["cache-control"]).toBe("private, no-store");
    const setCookie = created.headers()["set-cookie"];
    expect(setCookie).toMatch(/^__Host-nona_guest=[0-9a-f-]{36}(%2C[0-9a-f-]{36})*\.[A-Za-z0-9_-]{43};/);
    for (const flag of [/; HttpOnly/i, /; Secure/i, /; SameSite=Lax/i, /; Path=\//, /; Max-Age=63072000/]) {
      expect(setCookie).toMatch(flag);
    }
    expect(setCookie).not.toMatch(/; Domain=/i);
    const [cookie] = (await phone.cookies()).filter((stored) => stored.name === COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });

    // The same phone asking again is the same guest.
    expect(await ownGuestOf(phone)).toBe((await created.json()).guestId);
  } finally {
    await phone.close();
  }
});

test("a phone without a guest is asked first, and \"Yes, that's me\" brings the guest to it", async ({ browser, baseURL }) => {
  const firstPhone = await browser.newContext({ baseURL });
  const secondPhone = await browser.newContext({ baseURL });
  try {
    const { guestId, token } = await makeGuest(firstPhone.request, "E2E Linked Guest");

    const redirect = await secondPhone.request.get(`/my/${token}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()["location"]).toBe(`/my/${token}/confirm`);
    expect(redirect.headers()["cache-control"]).toBe("private, no-store");
    expect(redirect.headers()["set-cookie"]).toBeUndefined();

    const page = await secondPhone.newPage();
    const confirm = await page.goto(`/my/${token}`);
    await expect(page).toHaveURL(new RegExp(`/my/${token}/confirm$`));
    expect(confirm?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("heading", { name: "Is this you, E2E Linked Guest?" })).toBeVisible();
    await expect(page.getByText("This link keeps one guest's photos and videos together on any phone.")).toBeVisible();
    expect(await secondPhone.cookies()).toEqual([]);

    await page.getByRole("button", { name: "Yes, that's me" }).click();
    await expect(page).toHaveURL(/\/album\?view=mine$/);
    expect(await ownGuestOf(secondPhone)).toBe(guestId);
  } finally {
    await firstPhone.close();
    await secondPhone.close();
  }
});

test("\"No, I'm someone else\" gives the phone its own guest and keeps the link's uploads beside it", async ({ browser, baseURL }) => {
  const ownerPhone = await browser.newContext({ baseURL });
  const otherPhone = await browser.newContext({ baseURL });
  const sql = testDb();
  try {
    const owner = await makeGuest(ownerPhone.request, "E2E Link Owner");

    const page = await otherPhone.newPage();
    await page.goto(`/my/${owner.token}`);
    await page.getByRole("button", { name: "No, I'm someone else" }).click();
    await expect(page).toHaveURL(/\/album\?view=mine$/);

    const ownId = await ownGuestOf(otherPhone);
    expect(ownId).not.toBe(owner.guestId);
    expect(await cookieIds(otherPhone)).toEqual([ownId, owner.guestId]);
    const [{ display_name: ownerName }] = await sql`SELECT display_name FROM guests WHERE id = ${owner.guestId}`;
    expect(ownerName).toBe("E2E Link Owner");
  } finally {
    await sql.end();
    await ownerPhone.close();
    await otherPhone.close();
  }
});

const TAKE_OVER = "From now on, what you share here goes with this link. What you shared before stays in My uploads on this phone.";

test("a phone that has its own guest is asked too, and told what Yes does: the link becomes its own, its earlier guest remembered (Ruling CG)", async ({
  browser,
  baseURL,
}) => {
  const ownerPhone = await browser.newContext({ baseURL });
  const otherPhone = await browser.newContext({ baseURL });
  try {
    const owner = await makeGuest(ownerPhone.request, "E2E Second Owner");
    const other = await makeGuest(otherPhone.request, "E2E Other Guest");

    // Opening the link changes nothing by itself (Ruling S).
    const response = await otherPhone.request.get(`/my/${owner.token}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe(`/my/${owner.token}/confirm`);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await cookieIds(otherPhone)).toEqual([other.guestId]);

    const page = await otherPhone.newPage();
    await page.goto(`/my/${owner.token}`);
    await expect(page.getByRole("heading", { name: "Is this you, E2E Second Owner?" })).toBeVisible();
    await expect(page.getByText(TAKE_OVER)).toBeVisible();
    await page.getByRole("button", { name: "Yes, that's me" }).click();
    await expect(page).toHaveURL(/\/album\?view=mine$/);
    expect(await cookieIds(otherPhone)).toEqual([owner.guestId, other.guestId]);
  } finally {
    await ownerPhone.close();
    await otherPhone.close();
  }
});

test("\"No, I'm someone else\" on a phone with its own guest keeps it, and remembers the link's guest beside it", async ({ browser, baseURL }) => {
  const ownerPhone = await browser.newContext({ baseURL });
  const otherPhone = await browser.newContext({ baseURL });
  try {
    const owner = await makeGuest(ownerPhone.request, "E2E Third Owner");
    const other = await makeGuest(otherPhone.request, "E2E Another Guest");
    const page = await otherPhone.newPage();
    await page.goto(`/my/${owner.token}`);
    await page.getByRole("button", { name: "No, I'm someone else" }).click();
    await expect(page).toHaveURL(/\/album\?view=mine$/);
    expect(await cookieIds(otherPhone)).toEqual([other.guestId, owner.guestId]);
  } finally {
    await ownerPhone.close();
    await otherPhone.close();
  }
});

test("a phone whose own guest is the link's goes straight to its uploads", async ({ browser, baseURL }) => {
  const phone = await browser.newContext({ baseURL });
  try {
    const own = await makeGuest(phone.request, "E2E Own Link");
    const response = await phone.request.get(`/my/${own.token}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/album?view=mine");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await cookieIds(phone)).toEqual([own.guestId]);
  } finally {
    await phone.close();
  }
});

test("a choice posted from another site is refused and changes nothing", async ({ browser, baseURL }) => {
  const ownerPhone = await browser.newContext({ baseURL });
  const phone = await browser.newContext({ baseURL });
  try {
    const owner = await makeGuest(ownerPhone.request, "E2E Targeted Guest");
    const crossSite: Record<string, string>[] = [{}, { Origin: "https://attacker.example" }];
    for (const headers of crossSite) {
      const response = await phone.request.post(`/my/${owner.token}`, { form: { choice: "yes" }, headers, maxRedirects: 0 });
      expect(response.status()).toBe(403);
      expect(response.headers()["set-cookie"]).toBeUndefined();
    }
    expect(await phone.cookies()).toEqual([]);
  } finally {
    await ownerPhone.close();
    await phone.close();
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
