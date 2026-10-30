import { describe, expect, it } from "vitest";
import {
  decodeOriginalMetadata,
  encodeOriginalMetadata,
  fitOriginalMetadata,
  METADATA_TEXT_BYTES,
  truncateEncoded,
  type OriginalMetadata,
} from "./metadata";

const upload: OriginalMetadata = {
  guestId: "0b9f5c1e-7d1a-4a57-9a43-2f1c3e8d6b20",
  uploaderName: "Ama Ɔdɔ & Kwame 😊",
  originalFilename: "IMG_0001 (copy) 100% é.HEIC",
  startedAt: new Date("2026-12-05T15:04:05.000Z"),
};

describe("truncateEncoded", () => {
  it("keeps text that fits as it is", () => {
    expect(truncateEncoded("Ama", 9)).toBe("Ama");
    expect(truncateEncoded("Ɔdɔ", 13)).toBe("Ɔdɔ");
  });

  it("cuts between characters, never inside one", () => {
    // Encoded: Ɔ is 6 bytes, d 1, ɔ 6, and the emoji (two UTF-16 units) 12.
    expect(truncateEncoded("Ɔdɔ", 12)).toBe("Ɔd");
    expect(truncateEncoded("Ɔdɔ", 5)).toBe("");
    expect(truncateEncoded("a😊b", 12)).toBe("a");
    expect(truncateEncoded("a😊b", 13)).toBe("a😊");
    for (let maxBytes = 0; maxBytes < 40; maxBytes += 1) {
      const kept = truncateEncoded("😊Ɔa😊ɔ", maxBytes);
      expect(kept.isWellFormed()).toBe(true);
      expect(encodeURIComponent(kept).length).toBeLessThanOrEqual(maxBytes);
    }
  });
});

describe("fitOriginalMetadata", () => {
  it("leaves ordinary metadata alone", () => {
    expect(fitOriginalMetadata(upload)).toEqual(upload);
  });

  it("shortens a name and filename past the limit, and the whole stays under 2 KB", () => {
    const fitted = fitOriginalMetadata({
      ...upload,
      guestId: "g".repeat(128),
      uploaderName: "😊".repeat(500),
      originalFilename: "Ɛ".repeat(500),
    });
    expect(encodeURIComponent(fitted.uploaderName).length).toBeLessThanOrEqual(METADATA_TEXT_BYTES);
    expect(encodeURIComponent(fitted.originalFilename).length).toBeLessThanOrEqual(METADATA_TEXT_BYTES);
    const headers = encodeOriginalMetadata(fitted);
    const bytes = Object.entries(headers).reduce(
      (total, [name, value]) => total + name.length + value.length,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(1900);
  });
});

describe("encodeOriginalMetadata and decodeOriginalMetadata", () => {
  it("write ASCII headers and read the same metadata back", () => {
    const headers = encodeOriginalMetadata(upload);
    expect(headers).toEqual({
      "guest-id": upload.guestId,
      "uploader-name": encodeURIComponent(upload.uploaderName),
      "original-filename": encodeURIComponent(upload.originalFilename),
      "started-at": "2026-12-05T15:04:05.000Z",
    });
    for (const value of Object.values(headers)) expect(value).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeOriginalMetadata(headers)).toEqual(upload);
  });

  it("leave out a missing guest id and an empty name", () => {
    const siteUpload = { ...upload, guestId: null, uploaderName: "" };
    const headers = encodeOriginalMetadata(siteUpload);
    expect(Object.keys(headers).sort()).toEqual(["original-filename", "started-at"]);
    expect(decodeOriginalMetadata(headers)).toEqual(siteUpload);
  });

  it("read nothing from headers without a start time", () => {
    expect(decodeOriginalMetadata({})).toBeNull();
    expect(decodeOriginalMetadata({ "started-at": "yesterday" })).toBeNull();
  });
});
