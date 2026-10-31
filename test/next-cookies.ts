import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A stand-in for next/headers in unit tests: one browser's cookie jar. Reads see what the browser
 * sent; set() records the Set-Cookie (with its flags) and keeps the value for the next request, as
 * the browser would. Use it with vi.mock("next/headers", () => import("<path>/test/next-cookies")).
 *
 * A test that plays several browsers at once runs each one's requests inside asBrowser(jar, …), so
 * concurrent requests each see their own cookies; outside it, every request uses browserCookies.
 */
export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
};

export type SetCookie = { name: string; value: string; options: CookieOptions };

export type CookieJar = {
  values: Map<string, string>;
  /** Every Set-Cookie sent, oldest first. */
  sets: SetCookie[];
  clear(): void;
};

/** A browser's empty cookie jar. */
export function newCookieJar(): CookieJar {
  return {
    values: new Map<string, string>(),
    sets: [] as SetCookie[],
    clear() {
      this.values.clear();
      this.sets.length = 0;
    },
  };
}

export const browserCookies = newCookieJar();

const currentBrowser = new AsyncLocalStorage<CookieJar>();

/** Runs `request` as the browser holding `jar`: its cookies() calls read and write that jar. */
export function asBrowser<TResult>(jar: CookieJar, request: () => TResult): TResult {
  return currentBrowser.run(jar, request);
}

export async function cookies() {
  const jar = currentBrowser.getStore() ?? browserCookies;
  return {
    get(name: string) {
      const value = jar.values.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name: string, value: string, options: CookieOptions = {}) {
      jar.values.set(name, value);
      jar.sets.push({ name, value, options });
    },
  };
}
