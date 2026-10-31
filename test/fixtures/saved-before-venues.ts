/**
 * The celebrations as production saved them before each named its venue (30 Oct 2026): every
 * one carries its own place and directions link, and the reception its GhanaPost GPS as a place
 * detail. Saved content in this shape must keep parsing, or the site falls back to the built-in text.
 */
export const celebrationsSavedBeforeVenues = [
  {
    id: "ceremony",
    name: "White wedding",
    weekday: "Saturday",
    weekdayShort: "Sat",
    day: "05",
    month: "December",
    time: "[Start time] · please be seated early",
    place: "Assemblies of God, Victory Worship Centre, Tepa",
    dress: "Formal · black tie optional",
    directionsUrl: "#map",
    date: "2026-12-05",
    startTime: null,
    endTime: null,
  },
  {
    id: "reception",
    name: "Reception",
    weekday: "Saturday",
    weekdayShort: "Sat",
    day: "05",
    month: "December",
    time: "Right after the white wedding · dinner & dancing",
    place: "BN 111 Katakyie St, Tepa",
    placeDetail: "GhanaPost GPS · AX-0084-3317",
    dress: "Evening glamour",
    directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.018556,-2.145472",
    date: "2026-12-05",
    startTime: null,
    endTime: null,
  },
  {
    id: "thanks",
    name: "Thanksgiving service",
    weekday: "Sunday",
    weekdayShort: "Sun",
    day: "06",
    month: "December",
    time: "[Start time]",
    place: "Assemblies of God, Victory Worship Centre, Tepa",
    dress: "Your Sunday best",
    directionsUrl: "#map",
    date: "2026-12-06",
    startTime: null,
    endTime: null,
  },
];

/**
 * The order of the day as saved before its items could name a venue: each typed its venue's name,
 * with the town, as its place. One here leaves the town off and one is somewhere else, to show
 * both are read.
 */
export const scheduleSavedBeforeVenues = [
  { time: "[Time]", title: "Guests arrive", place: "Assemblies of God, Victory Worship Centre, Tepa", day: "sat" },
  { time: "[Time]", title: "White wedding", place: "Assemblies of God, Victory Worship Centre, Tepa", day: "sat" },
  { time: "[Time]", title: "Photos with the couple", place: "BN 111 Katakyie St, Tepa", day: "sat" },
  { time: "[Time]", title: "Reception dinner", place: "BN 111 Katakyie St", day: "sat" },
  { time: "[Time]", title: "After-party", place: "Rexco Junction, Tepa", day: "sat" },
  { time: "Sun 6 Dec", title: "Thanksgiving service", place: "Assemblies of God, Victory Worship Centre, Tepa", day: "sun" },
];
