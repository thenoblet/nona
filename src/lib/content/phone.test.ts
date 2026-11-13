import { describe, expect, it } from "vitest";
import { telHref } from "./phone";

describe("telHref", () => {
  it("dials a Ghana number with its country code", () => {
    expect(telHref("024 459 0772")).toBe("tel:+233244590772");
    expect(telHref("055 756 8088")).toBe("tel:+233557568088");
  });

  it("keeps a number typed with its own country code", () => {
    expect(telHref("+44 20 7946 0958")).toBe("tel:+442079460958");
    expect(telHref("+233 24 459 0772")).toBe("tel:+233244590772");
  });
});
