import { describe, expect, it } from "vitest";
import { dbConfig, googleMapsBrowserKey, guestCookieSecret, isDbConfigured, mediaBaseUrl, storageConfig } from "./env";

const full = {
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "nona",
  POSTGRES_USER: "nona",
  POSTGRES_PASSWORD: "secret",
};

describe("dbConfig", () => {
  it("reads the five POSTGRES_* variables", () => {
    expect(dbConfig(full)).toEqual({
      host: "localhost",
      port: 5432,
      database: "nona",
      user: "nona",
      password: "secret",
    });
  });

  it("names the missing variable", () => {
    expect(() => dbConfig({ ...full, POSTGRES_PASSWORD: undefined })).toThrow(
      "Missing database setting: POSTGRES_PASSWORD",
    );
  });

  it("treats an empty value as missing", () => {
    expect(() => dbConfig({ ...full, POSTGRES_HOST: "" })).toThrow("Missing database setting: POSTGRES_HOST");
  });

  it("refuses a port that isn't a whole positive number", () => {
    for (const port of ["five-four-three-two", "5432.5", "-1", "0"]) {
      expect(() => dbConfig({ ...full, POSTGRES_PORT: port })).toThrow();
    }
  });
});

describe("isDbConfigured", () => {
  it("is false when nothing is set", () => {
    expect(isDbConfigured({})).toBe(false);
  });

  it("is true when all five are set", () => {
    expect(isDbConfigured(full)).toBe(true);
  });

  it("is false when one is set but empty", () => {
    expect(isDbConfigured({ ...full, POSTGRES_DB: "" })).toBe(false);
  });
});

const storage = {
  R2_ENDPOINT: "http://localhost:9000",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_PRIVATE_BUCKET: "nona-private",
  R2_PUBLIC_BUCKET: "nona-public",
};

describe("storageConfig", () => {
  it("reads the five R2_* variables", () => {
    expect(storageConfig(storage)).toEqual({
      endpoint: "http://localhost:9000",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      privateBucket: "nona-private",
      publicBucket: "nona-public",
    });
  });

  it("names the missing variable", () => {
    expect(() => storageConfig({ ...storage, R2_SECRET_ACCESS_KEY: undefined })).toThrow(
      "Missing storage setting: R2_SECRET_ACCESS_KEY",
    );
  });

  it("treats an empty value as missing", () => {
    expect(() => storageConfig({ ...storage, R2_PUBLIC_BUCKET: "" })).toThrow(
      "Missing storage setting: R2_PUBLIC_BUCKET",
    );
  });

  it("refuses an endpoint that isn't an http(s) address", () => {
    for (const endpoint of ["localhost:9000", "ftp://localhost:9000", "not a url"]) {
      expect(() => storageConfig({ ...storage, R2_ENDPOINT: endpoint })).toThrow("R2_ENDPOINT");
    }
  });
});

describe("mediaBaseUrl", () => {
  it("reads MEDIA_BASE_URL without a trailing slash", () => {
    expect(mediaBaseUrl({ MEDIA_BASE_URL: "https://media.example.com/" })).toBe("https://media.example.com");
    expect(mediaBaseUrl({ MEDIA_BASE_URL: "http://localhost:9000/nona-public" })).toBe(
      "http://localhost:9000/nona-public",
    );
  });

  it("names the variable when it is missing or empty", () => {
    expect(() => mediaBaseUrl({})).toThrow("Missing storage setting: MEDIA_BASE_URL");
    expect(() => mediaBaseUrl({ MEDIA_BASE_URL: "" })).toThrow("Missing storage setting: MEDIA_BASE_URL");
  });

  it("refuses an address that isn't http(s)", () => {
    expect(() => mediaBaseUrl({ MEDIA_BASE_URL: "media.example.com" })).toThrow("MEDIA_BASE_URL");
  });
});

describe("guestCookieSecret", () => {
  const secret = "a".repeat(32);

  it("reads GUEST_COOKIE_SECRET", () => {
    expect(guestCookieSecret({ NODE_ENV: "production", GUEST_COOKIE_SECRET: secret })).toBe(secret);
  });

  it("refuses to run production without one, naming the variable", () => {
    expect(() => guestCookieSecret({ NODE_ENV: "production" })).toThrow(
      "Missing guest cookie setting: GUEST_COOKIE_SECRET",
    );
    expect(() => guestCookieSecret({ NODE_ENV: "production", GUEST_COOKIE_SECRET: "" })).toThrow(
      "Missing guest cookie setting: GUEST_COOKIE_SECRET",
    );
  });

  it("refuses a secret shorter than 32 bytes, in any environment", () => {
    for (const NODE_ENV of ["production", "development", "test"]) {
      expect(() => guestCookieSecret({ NODE_ENV, GUEST_COOKIE_SECRET: "a".repeat(31) })).toThrow(
        "GUEST_COOKIE_SECRET must be at least 32 bytes",
      );
    }
  });

  it("counts bytes, not characters", () => {
    // 16 characters of two bytes each: 32 bytes.
    expect(guestCookieSecret({ NODE_ENV: "production", GUEST_COOKIE_SECRET: "Ɔ".repeat(16) })).toBe("Ɔ".repeat(16));
    expect(() => guestCookieSecret({ NODE_ENV: "production", GUEST_COOKIE_SECRET: "Ɔ".repeat(15) })).toThrow();
  });

  it("falls back to a fixed value only in development and tests", () => {
    const development = guestCookieSecret({ NODE_ENV: "development" });
    expect(Buffer.byteLength(development)).toBeGreaterThanOrEqual(32);
    expect(guestCookieSecret({ NODE_ENV: "test" })).toBe(development);
  });

  it("fails closed without one anywhere else, NODE_ENV unset or unexpected included", () => {
    for (const NODE_ENV of [undefined, "", "staging", "Production", "dev"]) {
      expect(() => guestCookieSecret({ NODE_ENV })).toThrow("Missing guest cookie setting: GUEST_COOKIE_SECRET");
    }
  });
});

describe("googleMapsBrowserKey", () => {
  it("reads GOOGLE_MAPS_BROWSER_KEY, without stray spaces", () => {
    expect(googleMapsBrowserKey({ GOOGLE_MAPS_BROWSER_KEY: "browser-key" })).toBe("browser-key");
    expect(googleMapsBrowserKey({ GOOGLE_MAPS_BROWSER_KEY: " browser-key\n" })).toBe("browser-key");
  });

  it("has none when it is unset, empty or blank", () => {
    for (const GOOGLE_MAPS_BROWSER_KEY of [undefined, "", "   "]) {
      expect(googleMapsBrowserKey({ GOOGLE_MAPS_BROWSER_KEY })).toBeUndefined();
    }
  });
});
