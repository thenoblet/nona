import { describe, expect, it } from "vitest";
import { dbConfig, isDbConfigured, mediaBaseUrl, storageConfig } from "./env";

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
