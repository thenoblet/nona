import { describe, expect, it } from "vitest";
import { travelLines } from "./TravelText";

describe("travelLines", () => {
  it("keeps a short label at the start of a line apart from its text, which starts with a capital", () => {
    expect(travelLines("From Kumasi: about 2 hours by road.\nFrom Accra: about 6 to 7 hours.")).toEqual([
      { label: "From Kumasi", text: "About 2 hours by road." },
      { label: "From Accra", text: "About 6 to 7 hours." },
    ]);
  });

  it("leaves a line without a label, a time, or a long sentence before a colon as it is", () => {
    expect(travelLines("Three places close to the church.\n9:30 is when the bus leaves\nIf you are coming from very far away: call us")).toEqual([
      { label: null, text: "Three places close to the church." },
      { label: null, text: "9:30 is when the bus leaves" },
      { label: null, text: "If you are coming from very far away: call us" },
    ]);
  });

  it("skips empty lines and trims the rest", () => {
    expect(travelLines("  From Kumasi:  about 2 hours \n\n")).toEqual([{ label: "From Kumasi", text: "About 2 hours" }]);
  });
});
