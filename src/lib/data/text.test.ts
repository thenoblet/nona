import { describe, expect, it } from "vitest";
import { clampCharacters } from "./text";

describe("clampCharacters", () => {
  it("leaves text within the limit as it is", () => {
    expect(clampCharacters("Ama Owusu", 80)).toBe("Ama Owusu");
    expect(clampCharacters("a".repeat(80), 80)).toBe("a".repeat(80));
  });

  it("cuts longer text to the limit", () => {
    expect(clampCharacters("a".repeat(200), 80)).toBe("a".repeat(80));
  });

  it("counts characters as Postgres does, so an emoji is one, not two", () => {
    expect(clampCharacters("😊".repeat(100), 80)).toBe("😊".repeat(80));
  });

  it("never splits a character a reader sees: a skin-toned emoji or an accented letter stays whole or goes", () => {
    // 👍🏽 is two characters to Postgres; with one place left, it goes whole.
    expect(clampCharacters(`${"a".repeat(79)}👍🏽`, 80)).toBe("a".repeat(79));
    // e plus a combining acute accent, likewise.
    expect(clampCharacters(`${"a".repeat(79)}é`, 80)).toBe("a".repeat(79));
  });
});
