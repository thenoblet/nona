/**
 * A stand-in for next/headers in unit tests: one browser's cookie jar. Reads see what the browser
 * sent; set() records the Set-Cookie (with its flags) and keeps the value for the next request, as
 * the browser would. Use it with vi.mock("next/headers", () => import("<path>/test/next-cookies")).
 */
export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
};

export type SetCookie = { name: string; value: string; options: CookieOptions };

export const browserCookies = {
  values: new Map<string, string>(),
  /** Every Set-Cookie sent, oldest first. */
  sets: [] as SetCookie[],
  clear() {
    this.values.clear();
    this.sets.length = 0;
  },
};

export async function cookies() {
  return {
    get(name: string) {
      const value = browserCookies.values.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name: string, value: string, options: CookieOptions = {}) {
      browserCookies.values.set(name, value);
      browserCookies.sets.push({ name, value, options });
    },
  };
}
