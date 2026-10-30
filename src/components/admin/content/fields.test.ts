import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { sectionSpecs, type ListSpec } from "./fields";

const endsField = (sectionSpecs.celebrations as ListSpec).fields.find((field) => field.label === "Ends")!;
const hintFor = (startTime: string | null, endTime: string | null) => {
  const hint = endsField.hint;
  return typeof hint === "function" ? hint({ ...contentDefaults.celebrations[1], startTime, endTime }) : hint;
};

describe("the celebration editor's Ends field", () => {
  it("says when an end before the start means after midnight", () => {
    expect(hintFor("18:00", "02:00")).toBe("Ends after midnight");
  });

  it("says nothing for an end later the same day, a missing time or a half-typed one", () => {
    expect(hintFor("18:00", "23:30")).toBeUndefined();
    expect(hintFor(null, "02:00")).toBeUndefined();
    expect(hintFor("18:00", null)).toBeUndefined();
    expect(hintFor("18:00", "2:0")).toBeUndefined();
    expect(hintFor("18:00", "18:00")).toBeUndefined();
  });
});
