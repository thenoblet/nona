import type { ConfirmationCelebration } from "./CelebrationCard";

// Sample replies for the preview server (npm run email:preview), from a made-up guest and the
// built-in celebration text. Real emails are rendered from the reply and the saved site text.

const siteUrl = "https://nobletxnancy.com";

const celebrations: ConfirmationCelebration[] = [
  {
    id: "ceremony",
    name: "White wedding",
    date: "Saturday 5 December",
    time: "[Start time] · please be seated early",
    place: "Assemblies of God, Victory Worship Centre, Tepa",
    attending: true,
    googleCalendarUrl:
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=White+wedding+%C2%B7+Noblet+%26+Nancy&dates=20261205%2F20261206&location=Assemblies+of+God%2C+Victory+Worship+Centre%2C+Tepa&details=%5BStart+time%5D+%C2%B7+please+be+seated+early%0Ahttps%3A%2F%2Fnobletxnancy.com",
  },
  {
    id: "reception",
    name: "Reception",
    date: "Saturday 5 December",
    time: "Right after the white wedding · dinner & dancing",
    place: "BN 111 Katakyie St, Tepa",
    placeDetail: "GhanaPost GPS · AS-0084-3317",
    attending: true,
    googleCalendarUrl:
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Reception+%C2%B7+Noblet+%26+Nancy&dates=20261205%2F20261206&location=BN+111+Katakyie+St%2C+Tepa&details=Right+after+the+white+wedding+%C2%B7+dinner+%26+dancing%0Ahttps%3A%2F%2Fnobletxnancy.com",
  },
  {
    id: "thanks",
    name: "Thanksgiving service",
    date: "Sunday 6 December",
    time: "[Start time]",
    place: "Assemblies of God, Victory Worship Centre, Tepa",
    attending: false,
    googleCalendarUrl: null,
  },
];

/** Coming to the wedding and the reception, not to the thanksgiving service. */
export const sampleReply = { guestName: "Ama Owusu", celebrations, siteUrl };

/** Can come to none of the three. */
export const sampleDeclined = {
  guestName: "Kofi Mensah",
  celebrations: celebrations.map((celebration) => ({ ...celebration, attending: false, googleCalendarUrl: null })),
  siteUrl,
};
