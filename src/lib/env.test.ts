import { describe, expect, it } from "vitest";
import { dbConfig, isDbConfigured } from "./env";

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
});

describe("isDbConfigured", () => {
  it("is false when nothing is set", () => {
    expect(isDbConfigured({})).toBe(false);
  });

  it("is true when all five are set", () => {
    expect(isDbConfigured(full)).toBe(true);
  });
});
