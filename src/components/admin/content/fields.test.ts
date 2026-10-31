import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { sectionSpecs, type ListSpec } from "./fields";

const celebrationFields = (sectionSpecs.celebrations as ListSpec).fields;
const savedVenues = { venues: contentDefaults.venues };
const endsField = celebrationFields.find((field) => field.label === "Ends")!;
const hintFor = (startTime: string | null, endTime: string | null) => {
  const hint = endsField.hint;
  return typeof hint === "function" ? hint({ ...contentDefaults.celebrations[1], startTime, endTime }, savedVenues) : hint;
};

const venueField = celebrationFields.find((field) => field.path.join(".") === "venue");
const venueHint = (venue: string, context = savedVenues) => {
  const hint = venueField?.hint;
  return typeof hint === "function" ? hint({ ...contentDefaults.celebrations[0], venue }, context) : hint;
};

describe("the celebration editor's place", () => {
  it("is a choice of venue and an extra note, with no place, GPS or directions of its own", () => {
    expect(venueField).toMatchObject({
      label: "Venue",
      kind: "select",
      options: [
        { value: "church", label: "Church" },
        { value: "reception", label: "Reception venue" },
      ],
    });
    expect(celebrationFields.find((field) => field.path.join(".") === "placeDetail")?.label).toBe("Extra place note");
    const paths = celebrationFields.map((field) => field.path.join("."));
    expect(paths).not.toContain("place");
    expect(paths).not.toContain("directionsUrl");
    expect(celebrationFields.filter((field) => /gps|direction|^place/i.test(field.label))).toEqual([]);
  });

  it("says where the place, GPS and directions come from, as guests will see them", () => {
    expect(venueHint("reception")).toBe(
      "Place, GPS and directions come from Venues → Reception venue: BN 111 Katakyie St, Tepa · GhanaPost GPS · AX-0084-3317",
    );
    expect(venueHint("church")).toBe(
      "Place, GPS and directions come from Venues → Church: Assemblies of God, Victory Worship Centre, Tepa (no GPS yet)",
    );
  });

  it("shows the venue's saved GPS", () => {
    const venues = structuredClone(contentDefaults.venues);
    venues.reception.gps = "AS-1205-2026";
    expect(venueHint("reception", { venues })).toContain("GhanaPost GPS · AS-1205-2026");
  });
});

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
