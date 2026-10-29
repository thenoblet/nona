/**
 * Everything the couple knows ahead of time lives here.
 * Edit the words in this file; the pages read from it.
 * Square brackets mark details still to confirm.
 */

export const couple = {
  groom: "Noblet",
  bride: "Nancy",
  brideFull: "Nancy Fosu Gyamfi",
  monogram: "N & N",
  tag: "NONA'26",
  hashtag: "#NONA26",
  motto: "Always & Forever",
} as const;

export const wedding = {
  dateLong: "Saturday, 5 December 2026",
  dateShort: "05 · 12 · 2026",
  town: "Tepa",
  region: "Ashanti",
  rsvpBy: "23 November",
  /** The wedding weekend starts at midnight on 5 Dec (Ghana is GMT all year). */
  weekendStart: "2026-12-05T00:00:00Z",
  /** The thank-you version starts at midnight on 7 Dec. */
  weekendEnd: "2026-12-07T00:00:00Z",
  /** Countdown target. */
  countdownTo: "2026-12-05T00:00:00Z",
} as const;

export const venues = {
  church: {
    name: "Assemblies of God, Victory Worship Centre",
    address: "Tepa, Ashanti",
    gps: "[AS-0000-0000]",
    // TODO: swap for the exact Google Maps pin once confirmed.
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Assemblies+of+God+Victory+Worship+Centre+Tepa+Ghana",
  },
  reception: {
    name: "BN 111 Katakyie St",
    address: "Tepa, Ashanti",
    gps: "AS-0084-3317",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=BN+111+Katakyie+St+Tepa+Ghana",
  },
  hotel: {
    name: "[Guest hotel]",
    address: "[Street address], Tepa",
    gps: "[AS-0000-0000]",
    mapsUrl: "#map",
  },
} as const;

export type EventId = "ceremony" | "reception" | "thanks";

export type Celebration = {
  id: EventId;
  name: string;
  weekday: string;
  weekdayShort: string;
  day: string;
  month: string;
  time: string;
  place: string;
  placeDetail?: string;
  dress: string;
  directionsUrl: string;
};

export const celebrations: Celebration[] = [
  {
    id: "ceremony",
    name: "White wedding",
    weekday: "Saturday",
    weekdayShort: "Sat",
    day: "05",
    month: "December",
    time: "[Start time] · please be seated early",
    place: venues.church.name + ", Tepa",
    dress: "Formal · black tie optional",
    directionsUrl: "#map",
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
    placeDetail: "GhanaPost GPS · " + venues.reception.gps,
    dress: "Evening glamour",
    directionsUrl: venues.reception.mapsUrl,
  },
  {
    id: "thanks",
    name: "Thanksgiving service",
    weekday: "Sunday",
    weekdayShort: "Sun",
    day: "06",
    month: "December",
    time: "[Start time]",
    place: venues.church.name + ", Tepa",
    dress: "Your Sunday best",
    directionsUrl: "#map",
  },
];

export const story = {
  met: {
    when: "University · 2017",
    title: "How we met",
    text: "First year of university. She was the most collected, down-to-earth and, he'll tell you, the meanest-looking lady in the class. He was not deterred.",
  },
  asked: {
    when: "7 June 2026",
    title: "The night he asked",
    quote:
      "Nancy Fosu Gyamfi, delicate as lace, elegant as a fine home, tough as polished steel and the love of all my lives; will you marry me?",
    answer: "She said yes.",
  },
  forever: {
    when: "2026",
    title: "Forever begins",
    text: "Through every storm, one line has carried us. Now we get to say it as a vow.",
  },
} as const;

export type PartyMember = { name: string; role: string; lead?: boolean };

export const party: PartyMember[] = [
  { name: "Lilian", role: "Maid of honour", lead: true },
  { name: "James", role: "Best man", lead: true },
  { name: "Bernice", role: "Bridesmaid" },
  { name: "Jacqueline", role: "Bridesmaid" },
  { name: "Rahina", role: "Bridesmaid" },
  { name: "Priscilla", role: "Bridesmaid" },
  { name: "Afrifa", role: "Groomsman" },
  { name: "Dennis", role: "Groomsman" },
];

export const colours = [
  { name: "White", hex: "#FFFFFF" },
  { name: "Burnt orange", hex: "#E87F39" },
  { name: "Mocha", hex: "#6A524C" },
  { name: "Cocoa", hex: "#3D2927" },
] as const;

export const travel = [
  {
    icon: "bed",
    title: "Where to stay",
    text: "[Hotel name] is holding rooms for our guests until [date]. Quote [RATE CODE] when booking.",
    link: "Book a room",
  },
  {
    icon: "plane",
    title: "Getting to Tepa",
    text: "Flying in? Nearest airport: [Airport]. Add your flight to your reply and we'll help arrange a pickup.",
    link: "Travel details",
  },
  {
    icon: "pin",
    title: "While you're here",
    text: "[Your favourite places to eat and things to see around Tepa]: our personal guide for guests staying a few extra days.",
    link: "Our local guide",
  },
] as const;

export const gifts = [
  { title: "The registry", text: "A few things for our home", action: "View" },
  { title: "Bank transfer", text: "Our account details", action: "Show details" },
  { title: "Mobile money", text: "Send a gift in seconds", action: "Show details" },
] as const;

export const faq = [
  {
    q: "Can I bring a plus-one?",
    a: "[Your plus-one policy.] If you have a question, please reach out to [contact name].",
  },
  { q: "Are children welcome?", a: "[Your children policy.]" },
  {
    q: "Is the ceremony unplugged?",
    a: "[Phones away during the vows?] Our photographers will capture every moment, and the shared album opens right after.",
  },
  { q: "Where do I park?", a: "[Parking details for each venue.]" },
  {
    q: "Can't make it in person?",
    a: "Join the live stream from this page on the day. The link appears here an hour before the ceremony.",
  },
] as const;

export type ScheduleItem = { time: string; title: string; place: string; day: "sat" | "sun" };

export const schedule: ScheduleItem[] = [
  { time: "[Time]", title: "Guests arrive", place: venues.church.name + ", Tepa", day: "sat" },
  { time: "[Time]", title: "White wedding", place: venues.church.name + ", Tepa", day: "sat" },
  { time: "[Time]", title: "Photos with the couple", place: "BN 111 Katakyie St, Tepa", day: "sat" },
  { time: "[Time]", title: "Reception dinner", place: "BN 111 Katakyie St, Tepa", day: "sat" },
  { time: "[Time]", title: "First dance & party", place: "BN 111 Katakyie St, Tepa", day: "sat" },
  { time: "Sun 6 Dec", title: "Thanksgiving service", place: venues.church.name + ", Tepa", day: "sun" },
];
