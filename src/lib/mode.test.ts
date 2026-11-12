import { describe, expect, it } from "vitest";
import { modeAt } from "./mode";

describe("modeAt", () => {
  it("shows the wedding day until 05:00 on Sunday, then the after version", () => {
    expect(modeAt(new Date("2026-12-04T23:59:59Z"))).toBe("before");
    expect(modeAt(new Date("2026-12-05T00:00:00Z"))).toBe("day");
    expect(modeAt(new Date("2026-12-06T04:59:59Z"))).toBe("day");
    expect(modeAt(new Date("2026-12-06T05:00:00Z"))).toBe("after");
  });
});
