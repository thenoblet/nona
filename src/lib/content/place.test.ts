import { describe, expect, it } from "vitest";
import { contentDefaults } from "./defaults";
import { celebrationPlace, scheduleItemPlace } from "./place";

const [ceremony, reception, thanks] = contentDefaults.celebrations;
const venues = () => structuredClone(contentDefaults.venues);

describe("celebrationPlace", () => {
  it("gives the venue's name with the town, its GhanaPost GPS line and its map link", () => {
    expect(celebrationPlace(reception, contentDefaults.venues)).toEqual({
      place: "BN 111 Katakyie St, Tepa",
      gps: { label: "GhanaPost GPS · ", code: "AX-0084-3317" },
      gpsLine: "GhanaPost GPS · AX-0084-3317",
      directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.018556,-2.145472",
    });
  });

  it("gives no GPS line while the venue's GPS is still a placeholder in square brackets", () => {
    expect(contentDefaults.venues.church.gps).toBe("[AS-0000-0000]");
    expect(celebrationPlace(ceremony, contentDefaults.venues)).toEqual({
      place: "Assemblies of God, Victory Worship Centre, Tepa",
      gps: null,
      gpsLine: null,
      directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.019267,-2.145361",
    });
  });

  it("follows the venue's edits into every celebration held there", () => {
    const edited = venues();
    edited.church = { ...edited.church, name: "Victory Worship Centre", gps: "AS-0123-4567", mapsUrl: "https://maps.example.com/church" };
    edited.reception.gps = "AX-9999-0001";
    expect([ceremony, reception, thanks].map((celebration) => celebrationPlace(celebration, edited))).toEqual([
      { place: "Victory Worship Centre, Tepa", gps: { label: "GhanaPost GPS · ", code: "AS-0123-4567" }, gpsLine: "GhanaPost GPS · AS-0123-4567", directionsUrl: "https://maps.example.com/church" },
      { place: "BN 111 Katakyie St, Tepa", gps: { label: "GhanaPost GPS · ", code: "AX-9999-0001" }, gpsLine: "GhanaPost GPS · AX-9999-0001", directionsUrl: edited.reception.mapsUrl },
      { place: "Victory Worship Centre, Tepa", gps: { label: "GhanaPost GPS · ", code: "AS-0123-4567" }, gpsLine: "GhanaPost GPS · AS-0123-4567", directionsUrl: "https://maps.example.com/church" },
    ]);
  });

  it("joins the GPS line from its label and code, which a layout can also set apart", () => {
    const { gps, gpsLine } = celebrationPlace(reception, contentDefaults.venues);
    expect(gpsLine).toBe(`${gps!.label}${gps!.code}`);
  });

  it("follows the venue the celebration names", () => {
    expect(celebrationPlace({ ...thanks, venue: "reception" }, contentDefaults.venues)).toEqual(
      celebrationPlace(reception, contentDefaults.venues),
    );
  });
});

describe("scheduleItemPlace", () => {
  const [guestsArrive, , photos] = contentDefaults.schedule;

  it("gives a venue's name with the town for an item held there", () => {
    expect(scheduleItemPlace(guestsArrive, contentDefaults.venues)).toBe("Assemblies of God, Victory Worship Centre, Tepa");
    expect(scheduleItemPlace(photos, contentDefaults.venues)).toBe("BN 111 Katakyie St, Tepa");
  });

  it("follows a renamed venue", () => {
    const renamed = venues();
    renamed.reception.name = "Katakyie Gardens";
    expect(scheduleItemPlace(photos, renamed)).toBe("Katakyie Gardens, Tepa");
    expect(scheduleItemPlace(guestsArrive, renamed)).toBe("Assemblies of God, Victory Worship Centre, Tepa");
  });

  it("gives an item held anywhere else the place typed for it", () => {
    expect(scheduleItemPlace({ ...photos, venue: undefined, place: "Rexco Junction, Tepa" }, contentDefaults.venues)).toBe(
      "Rexco Junction, Tepa",
    );
  });
});
