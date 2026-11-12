import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { VENUE_LABELS } from "@/lib/content/schema";
import { fieldsInOrder, groupedIndexes, sectionSpecs, type GroupsSpec, type ListSpec } from "./fields";

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
        { value: "reception", label: "Reception" },
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
      "Place, GPS and directions come from Venues → Reception: BN 111 Katakyie St, Tepa · GhanaPost GPS · AX-0084-3317",
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

  it("names each venue as the Venues page heads it", () => {
    const legends = (sectionSpecs.venues as GroupsSpec).groups.map((group) => [group.key, group.legend]);
    expect(legends).toEqual(Object.entries(VENUE_LABELS));
    expect(legends).toEqual([
      ["church", "Church"],
      ["reception", "Reception"],
      ["hotel", "Hotel"],
    ]);
  });
});

describe("the order of the day editor", () => {
  const scheduleSpec = sectionSpecs.schedule as ListSpec;
  const programme = [
    { celebration: "reception", title: "Guests arrive" },
    { celebration: "ceremony", title: "Guests arrive" },
    { celebration: "ceremony", title: "Vows" },
  ];

  it("groups the items by celebration, in the order they happen", () => {
    expect(groupedIndexes(scheduleSpec, programme)).toEqual([
      { value: "ceremony", label: "White wedding", indexes: [1, 2] },
      { value: "reception", label: "Reception", indexes: [0] },
    ]);
  });

  it("lists an item in no celebration last, under no heading", () => {
    const lost = [...programme, { celebration: "brunch", title: "Brunch" }];
    expect(groupedIndexes(scheduleSpec, lost).at(-1)).toEqual({ value: null, label: null, indexes: [3] });
  });

  it("names each field with its celebration, as two can each have a Guests arrive", () => {
    expect(fieldsInOrder(scheduleSpec, programme.slice(0, 2)).map((field) => field.name)).toEqual([
      "White wedding · Guests arrive · Time",
      "White wedding · Guests arrive · What happens",
      "White wedding · Guests arrive · Celebration",
      "White wedding · Guests arrive · Note",
      "White wedding · Guests arrive · Place",
      "Reception · Guests arrive · Time",
      "Reception · Guests arrive · What happens",
      "Reception · Guests arrive · Celebration",
      "Reception · Guests arrive · Note",
      "Reception · Guests arrive · Place",
    ]);
  });

  it("adds a new item to the celebration it is added under", () => {
    const editable = scheduleSpec.editable!;
    expect(editable.newItem(programme, "reception")).toMatchObject({ celebration: "reception", title: "" });
    expect(typeof editable.addLabel === "function" && editable.addLabel("Reception")).toBe("Add an item to the Reception");
  });

  it("chooses the celebration from the two", () => {
    expect(scheduleSpec.fields.find((field) => field.label === "Celebration")?.options).toEqual([
      { value: "ceremony", label: "White wedding" },
      { value: "reception", label: "Reception" },
    ]);
  });
});

describe("an ungrouped list", () => {
  it("shows its items together, in order", () => {
    const faqSpec = sectionSpecs.faq as ListSpec;
    expect(groupedIndexes(faqSpec, contentDefaults.faq)).toEqual([
      { value: null, label: null, indexes: contentDefaults.faq.map((_item, index) => index) },
    ]);
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
