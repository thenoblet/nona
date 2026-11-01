import { describe, expect, it } from "vitest";
import {
  assertDerivedKey,
  assertOriginalKey,
  DERIVED_VARIANTS,
  derivedFolder,
  derivedKey,
  manifestKey,
  originalKey,
  publicUrl,
} from "./keys";

const mediaId = "0b9f5c1e-7d1a-4a57-9a43-2f1c3e8d6b20";
const contentHash = "9f86d081884c7d659a2feaa0c55ad015";

describe("originalKey", () => {
  it("puts the original under originals/ with its extension", () => {
    expect(originalKey(mediaId, "heic")).toBe(`originals/${mediaId}.heic`);
  });
});

describe("derivedKey", () => {
  it("puts each derived file under its media id and content hash", () => {
    expect(derivedKey(mediaId, contentHash, "thumb", "webp")).toBe(
      `derived/${mediaId}/${contentHash}/thumb.webp`,
    );
    expect(derivedKey(mediaId, contentHash, "poster-view", "webp")).toBe(
      `derived/${mediaId}/${contentHash}/poster-view.webp`,
    );
  });

  it("knows every variant the worker writes", () => {
    expect(DERIVED_VARIANTS).toEqual([
      "thumb",
      "view",
      "jpeg",
      "poster-thumb",
      "poster-view",
      "video",
      "playable",
      "audio",
      "card",
      "medium",
      "large",
    ]);
    for (const variant of DERIVED_VARIANTS) {
      expect(derivedKey(mediaId, contentHash, variant, "bin")).toBe(
        `derived/${mediaId}/${contentHash}/${variant}.bin`,
      );
    }
  });

  it("refuses a variant it doesn't know", () => {
    // A value read from the database is only a string at run time.
    const unknown = "original" as (typeof DERIVED_VARIANTS)[number];
    expect(() => derivedKey(mediaId, contentHash, unknown, "webp")).toThrow("variant");
  });
});

describe("derivedFolder", () => {
  it("is the folder of every derived file of the item, whatever its content hash", () => {
    expect(derivedFolder("abc-123")).toBe("derived/abc-123/");
    expect(derivedKey("abc-123", "hash", "thumb", "webp").startsWith(derivedFolder("abc-123"))).toBe(true);
    expect(() => derivedFolder("../x")).toThrow("mediaId");
    expect(() => derivedFolder("")).toThrow("mediaId");
  });
});

describe("manifestKey", () => {
  it("puts the manifest under manifests/ as JSON", () => {
    expect(manifestKey(mediaId)).toBe(`manifests/${mediaId}.json`);
  });
});

describe("the key builders", () => {
  const unsafe = ["..", ".", "", "a/b", "/", "../escape", "a\\b", "with space", "%2e%2e"];

  it("refuse a media id that could leave its folder or is empty", () => {
    for (const value of unsafe) {
      expect(() => originalKey(value, "jpg"), value).toThrow("mediaId");
      expect(() => derivedKey(value, contentHash, "thumb", "webp"), value).toThrow("mediaId");
      expect(() => manifestKey(value), value).toThrow("mediaId");
    }
  });

  it("refuse an unsafe or empty content hash", () => {
    for (const value of unsafe) {
      expect(() => derivedKey(mediaId, value, "thumb", "webp"), value).toThrow("contentHash");
    }
  });

  it("refuse an unsafe or empty extension", () => {
    for (const value of [...unsafe, "tar.gz", ".jpg"]) {
      expect(() => originalKey(mediaId, value), value).toThrow("extension");
      expect(() => derivedKey(mediaId, contentHash, "thumb", value), value).toThrow("extension");
    }
  });
});

describe("publicUrl", () => {
  it("joins MEDIA_BASE_URL and the key", () => {
    const key = derivedKey(mediaId, contentHash, "thumb", "webp");
    expect(publicUrl(key, { MEDIA_BASE_URL: "https://media.example.com/" })).toBe(
      `https://media.example.com/${key}`,
    );
  });

  it("reads MEDIA_BASE_URL from the environment by default", () => {
    expect(publicUrl("derived/a/b/view.webp")).toBe(`${process.env.MEDIA_BASE_URL}/derived/a/b/view.webp`);
  });
});

describe("assertOriginalKey and assertDerivedKey", () => {
  const original = originalKey(mediaId, "heic");
  const derived = derivedKey(mediaId, contentHash, "poster-view", "webp");

  it("accept the keys the builders make", () => {
    expect(assertOriginalKey(original)).toBe(original);
    expect(assertDerivedKey(derived)).toBe(derived);
  });

  it("refuse a key from anywhere else", () => {
    for (const key of [
      derived,
      manifestKey(mediaId),
      "originals/a/b.jpg",
      "originals/../x.jpg",
      "zips/a.zip",
      "",
    ]) {
      expect(() => assertOriginalKey(key), key).toThrow("originals/");
    }
    for (const key of [
      original,
      manifestKey(mediaId),
      `derived/${mediaId}/${contentHash}/original.jpg`,
      `derived/${mediaId}/thumb.webp`,
      `derived/${mediaId}/../${contentHash}/thumb.webp`,
      "",
    ]) {
      expect(() => assertDerivedKey(key), key).toThrow("derived/");
    }
  });
});
