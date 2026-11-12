import type { Celebration, EventId, PartyMember, ScheduleItem } from "@/lib/content/schema";

export type { Celebration, EventId, PartyMember, ScheduleItem };

/**
 * Everything the couple knows ahead of time lives here. The pages read `couple`, `wedding` and
 * `colours` straight from this file. The rest (celebrations, venues, landmarks, story, party,
 * travel, FAQ, live stream and schedule) is the built-in text: the site shows it until a
 * section is saved in the admin (/admin/content), and whenever the database can't be reached.
 * Once a section is saved there, changing it here no longer changes the site. The RSVP settings
 * work the same way, saved on the admin's Replies page (/admin/rsvps).
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
  /** The reply-by date until the couple set one in the admin; pages read `rsvp.replyBy`. */
  rsvpBy: "2026-11-20",
  /** The wedding weekend starts at midnight on 5 Dec (Ghana is GMT all year). */
  weekendStart: "2026-12-05T00:00:00Z",
  /** The after version starts at 05:00 on Sunday 6 Dec, once Saturday night is over. */
  weekendEnd: "2026-12-06T05:00:00Z",
  /** Countdown target. */
  countdownTo: "2026-12-05T00:00:00Z",
} as const;

export const venues = {
  church: {
    name: "Assemblies of God, Victory Worship Centre",
    address: "Tepa, Ashanti",
    gps: "[AS-0000-0000]",
    coords: { lat: 7.019267, lng: -2.145361 },
    mapsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.019267,-2.145361",
  },
  reception: {
    name: "BN 111 Katakyie St",
    address: "Tepa, Ashanti",
    gps: "AX-0084-3317",
    coords: { lat: 7.018556, lng: -2.145472 },
    mapsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.018556,-2.145472",
    note: "About a minute's walk from the church",
  },
  hotel: {
    name: "[Guest hotel]",
    address: "[Street address], Tepa",
    gps: "[AS-0000-0000]",
    mapsUrl: "#map",
  },
} as const;

/** Landmarks guests can ask for on the way. Shown as a note over the map, not as pins. */
export const landmarks = ["Rexco", "Amel Junction"] as const;

/** Each celebration's place, GhanaPost GPS and directions come from its venue, above. */
export const celebrations: Celebration[] = [
  {
    id: "ceremony",
    venue: "church",
    name: "White wedding",
    weekday: "Saturday",
    weekdayShort: "Sat",
    day: "05",
    month: "December",
    time: "10:00 AM · guests arrive from 9:15",
    dress: "Formal · black tie optional",
    date: "2026-12-05",
    startTime: "10:00",
    endTime: "14:00",
  },
  {
    id: "reception",
    venue: "reception",
    name: "Reception",
    weekday: "Saturday",
    weekdayShort: "Sat",
    day: "05",
    month: "December",
    time: "2:30 PM, a short walk from the church",
    dress: "Evening glamour",
    date: "2026-12-05",
    startTime: "14:30",
    endTime: "19:30",
  },
  {
    id: "thanks",
    venue: "church",
    name: "Thanksgiving service",
    weekday: "Sunday",
    weekdayShort: "Sun",
    day: "06",
    month: "December",
    time: "[Start time]",
    dress: "Your Sunday best",
    date: "2026-12-06",
    startTime: null,
    endTime: null,
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

export const party: PartyMember[] = [
  { id: "lilian", name: "Lilian", role: "Maid of honour", lead: true },
  { id: "james", name: "James", role: "Best man", lead: true },
  { id: "bernice", name: "Bernice", role: "Bridesmaid" },
  { id: "jacqueline", name: "Jacqueline", role: "Bridesmaid" },
  { id: "rahina", name: "Rahina", role: "Bridesmaid" },
  { id: "priscilla", name: "Priscilla", role: "Bridesmaid" },
  { id: "afrifa", name: "Afrifa", role: "Groomsman" },
  { id: "dennis", name: "Dennis", role: "Groomsman" },
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
    icon: "pin",
    title: "Getting to Tepa",
    text: "Coming by road? [Directions to Tepa, how long the drive takes and where to park.]",
    link: "Travel details",
  },
  {
    icon: "heart",
    title: "While you're here",
    text: "[Your favourite places to eat and things to see around Tepa]: our personal guide for guests staying a few extra days.",
    link: "Our local guide",
  },
] as const;

export const faq = [
  {
    question: "Can I bring a plus-one?",
    answer: "[Your plus-one policy.] If you have a question, please reach out to [contact name].",
  },
  { question: "Are children welcome?", answer: "[Your children policy.]" },
  {
    question: "Is the ceremony unplugged?",
    answer: "[Phones away during the vows?] Our photographers will capture every moment, and the shared album opens right after.",
  },
  { question: "Where do I park?", answer: "[Parking details for each venue.]" },
  {
    question: "Can't make it in person?",
    answer: "Join the live stream from this page on the day. The link appears here an hour before the ceremony.",
    topic: "live-stream",
  },
] as const;

/** The live-stream link; null until the couple add it. */
export const liveStream: { url: string | null } = { url: null };

/** Replies are open until the couple close them; while closed, /rsvp shows this message instead of the form. */
export const rsvp = {
  open: true,
  replyBy: wedding.rsvpBy,
  closedMessage:
    "Replies are now closed. Thank you to everyone who let us know! If your plans have changed, please message Noblet or Nancy directly.",
};

/**
 * The order of the day, in order, each item part of one celebration: the white wedding as the
 * officiating pastor set it, then the reception, from the couple's programme (Nov 2026). Times are
 * 24-hour and provisional until the church approves them; an item without one shows no time. Each
 * item happens at its celebration's venue unless it types another `place`.
 */
export const schedule: ScheduleItem[] = [
  { celebration: "ceremony", time: "09:15", title: "Arrival of guests", note: "The MC welcomes and seats everyone" },
  { celebration: "ceremony", time: "10:00", title: "Opening prayer" },
  { celebration: "ceremony", time: "10:05", title: "Entry of the bride" },
  { celebration: "ceremony", time: "10:15", title: "Call to worship" },
  { celebration: "ceremony", time: "10:25", title: "First and second Bible readings" },
  { celebration: "ceremony", time: "10:35", title: "Solo ministration" },
  { celebration: "ceremony", time: "10:45", title: "Sermon" },
  { celebration: "ceremony", time: "11:10", title: "Exchange of vows" },
  { celebration: "ceremony", time: "11:30", title: "Signing of the marriage certificate" },
  { celebration: "ceremony", time: "12:05", title: "Presentation of the marriage certificate" },
  { celebration: "ceremony", time: "12:10", title: "Prayers" },
  { celebration: "ceremony", time: "12:20", title: "Introduction of dignitaries" },
  { celebration: "ceremony", time: "12:35", title: "Song ministrations" },
  { celebration: "ceremony", time: "13:15", title: "Presentation of gifts" },
  { celebration: "ceremony", time: "13:25", title: "Vote of thanks" },
  { celebration: "ceremony", time: "13:35", title: "Announcements" },
  { celebration: "ceremony", time: "13:40", title: "Closing prayer" },
  { celebration: "ceremony", time: "13:45", title: "Benediction" },
  { celebration: "ceremony", time: "13:50", title: "Recessional", note: "Ushers will guide you on the short walk to the reception" },
  { celebration: "reception", time: "14:00", title: "Walk to the reception", note: "A one-to-two-minute walk from the church" },
  { celebration: "reception", time: "14:10", title: "Welcome refreshments and seating" },
  { celebration: "reception", time: "14:30", title: "Opening prayer" },
  { celebration: "reception", time: "14:40", title: "Welcome address by the MC" },
  { celebration: "reception", time: "14:50", title: "Bridal party entrance" },
  { celebration: "reception", time: "15:05", title: "Grand entrance of the newly married couple" },
  { celebration: "reception", time: "15:20", title: "Official introduction of the couple" },
  { celebration: "reception", time: "15:30", title: "First dance" },
  { celebration: "reception", time: "15:50", title: "Cutting of the cake" },
  { celebration: "reception", time: "16:05", title: "Toast to the couple" },
  { celebration: "reception", time: "16:20", title: "Bride's family speech" },
  { celebration: "reception", time: "16:35", title: "Groom's family speech" },
  { celebration: "reception", time: "16:50", title: "Best men and maids of honour speeches" },
  { celebration: "reception", time: "17:05", title: "The couple's appreciation speech" },
  { celebration: "reception", time: "17:20", title: "Lunch and refreshments" },
  { celebration: "reception", time: "18:00", title: "Live band" },
  { celebration: "reception", time: "18:30", title: "Special dedication to the couple" },
  { celebration: "reception", time: "18:45", title: "Bouquet toss" },
  { celebration: "reception", time: "18:55", title: "DJ and open dance floor" },
  { celebration: "reception", time: "19:25", title: "Closing remarks and appreciation" },
  { celebration: "thanks", title: "Sunday service" },
  { celebration: "thanks", title: "Thanksgiving", note: "The couple give thanks with family and friends" },
  { celebration: "thanks", title: "Closing & photos" },
];
