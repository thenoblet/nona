import { describe, expect, it } from "vitest";
import { NAME_MAX_CHARACTERS } from "@/lib/db/schema";
import { SIGNATURE_MAX_CHARACTERS, SIGNATURE_WORDS, signatureProblem } from "./signature";

describe("a wish's signature", () => {
  it("may be as long as a guest's name, counted as Postgres counts characters", () => {
    expect(SIGNATURE_MAX_CHARACTERS).toBe(NAME_MAX_CHARACTERS);
    expect(signatureProblem("A".repeat(80))).toBeNull();
    expect(signatureProblem("👋".repeat(80))).toBeNull();
    expect(signatureProblem("A".repeat(81))).toBe(SIGNATURE_WORDS.tooLong);
  });

  it("must be there", () => {
    expect(signatureProblem("")).toBe("Please sign your wish with your name.");
    expect(signatureProblem("Ama")).toBeNull();
  });
});
