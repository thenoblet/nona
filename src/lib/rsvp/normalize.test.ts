import { describe, expect, it } from "vitest";
import { emailKey, nameKey, phoneKey, phoneSearchKeys, plainName } from "./normalize";

describe("nameKey", () => {
  it("ignores case and extra spaces", () => {
    expect(nameKey("  ama  OWUSU ")).toBe(nameKey("Ama Owusu"));
  });
  it("keeps Ghanaian letters", () => {
    expect(nameKey("Akosua Ɔfori")).toContain("ɔ");
    expect(nameKey("Kofi Ɛnyo")).toContain("ɛ");
  });
  it("strips combining diacritics", () => {
    expect(nameKey("Ama Ówusu")).toBe("ama owusu");
  });
});

describe("phoneKey", () => {
  it("turns +233 into a leading 0", () => {
    expect(phoneKey("+233 24 000 0000")).toBe("0240000000");
  });
  it("reads every way of writing a Ghana number as the same key", () => {
    for (const written of ["024 000 0000", "+233 24 000 0000", "+233 (0)24 000 0000", "+2330240000000", "00233 24 000 0000", "00233 (0)24 000 0000"]) {
      expect(phoneKey(written)).toBe("0240000000");
    }
  });
  it("reads 00 as + for numbers from abroad", () => {
    expect(phoneKey("0044 7700 900123")).toBe(phoneKey("+44 7700 900123"));
  });
  it("keeps digits only", () => {
    expect(phoneKey("024-000-0000")).toBe("0240000000");
    expect(phoneKey("0240000000")).toBe("0240000000");
  });
});

describe("emailKey", () => {
  it("trims and lower-cases", () => {
    expect(emailKey("  Ama@Example.COM ")).toBe("ama@example.com");
  });
});

describe("phoneSearchKeys", () => {
  it("is the typed number's phoneKey once the number is whole", () => {
    expect(phoneSearchKeys("+233 (0)24 000 0000")).toEqual(["0240000000"]);
    expect(phoneSearchKeys("0044 7700 900123")).toEqual(["447700900123"]);
  });
  it("also reads a number typed only partly after the country code in its local form", () => {
    for (const typed of ["+233 24", "+233 (0)24", "00233 24", "00233 (0)24"]) {
      expect(phoneSearchKeys(typed), typed).toContain("024");
    }
  });
  it("keeps the first digits of a local number as they are", () => {
    expect(phoneSearchKeys("0240")).toEqual(["0240"]);
    expect(phoneSearchKeys("233")).toEqual(["233"]);
  });
  it("is nothing for a number with no digits yet", () => {
    expect(phoneSearchKeys("00")).toEqual([]);
    expect(phoneSearchKeys("+")).toEqual([]);
  });
});

describe("plainName", () => {
  it.each(["Ama Owusu", "Akosua Ɔfori-Atta", "Ámà Owusu-Ansah", "Ama\u0301 Owusu", "Nana Yaa O'Neil", "J. Doe", "Kwame Mensah Jr."])(
    "keeps %s, a plain name",
    (name) => {
      expect(plainName(name)).toBe(name);
    },
  );

  it.each([
    "bit.ly/x",
    "bit.ly",
    "Claim your gift at evil.example",
    "see http://evil.test",
    "visit www.evil.test",
    "a@evil.test",
    "evil.com",
    "a.b.c",
    "пример.рф",
    "Call 024 000 0000",
    "A".repeat(61),
  ])("refuses %s, which could read as a link, an address or a number", (name) => {
    expect(plainName(name)).toBeNull();
  });
});
