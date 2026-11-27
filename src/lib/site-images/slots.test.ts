import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { allSlots, isSlotId, previewOf, previewSlotId, slotDefinition, SLOT_GROUPS } from "./slots";

describe("the slots", () => {
  it("are the spec's: landing cover and print, home hero, invitation band, story, gallery, the four cards, one per member, and the MC", () => {
    const slots = allSlots(contentDefaults.party);
    const ids = slots.map((slot) => slot.id);
    expect(ids.slice(0, 18)).toEqual([
      "landing-cover",
      "landing-print",
      "home-hero",
      "invitation-band",
      "story-met-arch",
      "story-met-print",
      "story-met-second-print",
      "story-asked-arch",
      "story-asked-print",
      "story-forever-arch",
      "story-forever-print",
      "gallery-left",
      "gallery-centre",
      "gallery-right",
      "preview-invitation",
      "preview-rsvp",
      "preview-album",
      "preview-wishes",
    ]);
    expect(ids.slice(18)).toEqual([...contentDefaults.party.map((member) => `party-${member.id}`), "host-portrait"]);
    expect(new Set(slots.map((slot) => slot.group))).toEqual(new Set(SLOT_GROUPS.map((group) => group.id)));
    // Every slot lists sizes up to twice its widest CSS width.
    for (const slot of slots) expect(slot.maxWidth).toBeGreaterThan(0);
  });

  it("knows which slots draw a preview card", () => {
    expect(previewOf("preview-album")).toBe("album");
    expect(previewOf("home-hero")).toBeNull();
    expect(previewSlotId("rsvp")).toBe("preview-rsvp");
  });

  it("accepts only a slot's id, a member's portrait included, before anything is saved under it", () => {
    expect(isSlotId("home-hero")).toBe(true);
    expect(isSlotId("party-maid-of-honour")).toBe(true);
    expect(isSlotId("party-")).toBe(false);
    expect(isSlotId("party-Lilian")).toBe(false);
    expect(isSlotId("hero")).toBe(false);
    expect(isSlotId(`party-${"a".repeat(200)}`)).toBe(false);
    expect(isSlotId(42)).toBe(false);
  });

  it("names a member's slot from the site text, or by its id once they leave the list", () => {
    expect(slotDefinition("party-lilian", contentDefaults.party)).toMatchObject({ name: "Lilian", where: "Maid of honour", shape: "oval" });
    expect(slotDefinition("party-gone", contentDefaults.party)).toMatchObject({ name: "gone" });
    expect(slotDefinition("nope")).toBeNull();
  });

  it("keeps the MC's portrait among the wedding party's, an oval, after the members", () => {
    const host = slotDefinition("host-portrait");
    expect(host).toMatchObject({ group: "party", name: "MC", shape: "oval" });
    expect(isSlotId("host-portrait")).toBe(true);
    expect(allSlots([]).at(-1)?.id).toBe("host-portrait");
  });
});
