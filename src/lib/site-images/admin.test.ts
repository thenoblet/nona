import { describe, expect, it } from "vitest";
import { altHintOf, slotView } from "./admin";
import { slotDefinition } from "./slots";

describe("the editor's alt-text hint", () => {
  it("says the photo behind text, and a link preview's, are never read aloud; the rest are", () => {
    const hint = (slotId: string) => altHintOf(slotDefinition(slotId)!);
    expect(hint("home-hero")).toBe("Not read aloud: this photo sits behind text.");
    expect(hint("invitation-band")).toBe("Not read aloud: this photo sits behind text.");
    expect(hint("preview-album")).toBe("Not read aloud: the link preview describes the card in its own words.");
    expect(hint("story-met-arch")).toBe("Read aloud to guests who can't see the photo.");
    expect(hint("party-lilian")).toBe("Read aloud to guests who can't see the photo.");
    expect(slotView(slotDefinition("home-hero")!, []).altHint).toBe("Not read aloud: this photo sits behind text.");
  });

  it("says where the home hero shows, true after the wedding too", () => {
    expect(slotDefinition("home-hero")?.where).toBe(
      "Behind your names at the top of the home page, until the wedding weekend ends; darkened so they stay clear.",
    );
  });
});
