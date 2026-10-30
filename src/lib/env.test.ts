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
