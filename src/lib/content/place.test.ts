import { describe, expect, it } from "vitest";
import { contentDefaults } from "./defaults";
import { celebrationPlace } from "./place";

const [ceremony, reception, thanks] = contentDefaults.celebrations;
const venues = () => structuredClone(contentDefaults.venues);

describe("celebrationPlace", () => {
  it("gives the venue's name with the town, its GhanaPost GPS line and its map link", () => {
    expect(celebrationPlace(reception, contentDefaults.venues)).toEqual({
      place: "BN 111 Katakyie St, Tepa",
      gpsLine: "GhanaPost GPS · AX-0084-3317",
      directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.018556,-2.145472",
    });
  });

  it("gives no GPS line while the venue's GPS is still a placeholder in square brackets", () => {
    expect(contentDefaults.venues.church.gps).toBe("[AS-0000-0000]");
    expect(celebrationPlace(ceremony, contentDefaults.venues)).toEqual({
      place: "Assemblies of God, Victory Worship Centre, Tepa",
      gpsLine: null,
      directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.019267,-2.145361",
    });
  });

  it("follows the venue's edits into every celebration held there", () => {
    const edited = venues();
    edited.church = { ...edited.church, name: "Victory Worship Centre", gps: "AS-0123-4567", mapsUrl: "https://maps.example.com/church" };
    edited.reception.gps = "AX-9999-0001";
    expect([ceremony, reception, thanks].map((celebration) => celebrationPlace(celebration, edited))).toEqual([
      { place: "Victory Worship Centre, Tepa", gpsLine: "GhanaPost GPS · AS-0123-4567", directionsUrl: "https://maps.example.com/church" },
      { place: "BN 111 Katakyie St, Tepa", gpsLine: "GhanaPost GPS · AX-9999-0001", directionsUrl: edited.reception.mapsUrl },
      { place: "Victory Worship Centre, Tepa", gpsLine: "GhanaPost GPS · AS-0123-4567", directionsUrl: "https://maps.example.com/church" },
    ]);
  });

  it("follows the venue the celebration names", () => {
    expect(celebrationPlace({ ...thanks, venue: "reception" }, contentDefaults.venues)).toEqual(
      celebrationPlace(reception, contentDefaults.venues),
    );
  });
});
