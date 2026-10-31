import { describe, expect, it } from "vitest";
import { clampCharacters, cleanFilename, cleanName } from "./text";

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

describe("cleanName", () => {
  it("trims a name and keeps at most 80 characters, an empty one as none", () => {
    expect(cleanName(" Ama Owusu ")).toBe("Ama Owusu");
    expect(cleanName("A".repeat(500))).toBe("A".repeat(80));
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(null)).toBeNull();
    expect(cleanName(undefined)).toBeNull();
  });

  it("drops control characters, which Postgres refuses (NUL) or a tile can't show", () => {
    expect(cleanName("Ama\u0000 Owusu\u0007\n")).toBe("Ama Owusu");
    expect(cleanName("\u0000\u001f")).toBeNull();
  });

  it("keeps none rather than an empty name when its one character is longer than 80", () => {
    // A single grapheme of 81 code points: a letter with 80 combining accents.
    expect(cleanName(`a${"\u0301".repeat(80)}`)).toBeNull();
  });

  it("replaces a lone surrogate, which isn't valid text, instead of failing the query", () => {
    expect(cleanName("Ama \ud800")).toBe("Ama \ufffd");
  });
});

describe("cleanFilename", () => {
  it("keeps the last part of a path, without control characters, at most 255 characters", () => {
    expect(cleanFilename("IMG_0001.HEIC")).toBe("IMG_0001.HEIC");
    expect(cleanFilename("C:\\Users\\Ama\\IMG_7.JPG")).toBe("IMG_7.JPG");
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename(" photo\u0000.jpg ")).toBe("photo.jpg");
    expect(cleanFilename(`${"a".repeat(300)}.jpg`)).toBe("a".repeat(255));
    expect(cleanFilename("")).toBe("");
  });
});
