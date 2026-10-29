import { describe, expect, it } from "vitest";
import { emailKey, nameKey, phoneKey } from "./normalize";

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
