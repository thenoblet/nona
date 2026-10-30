import { describe, expect, it, vi } from "vitest";
import { celebrationEvent, googleCalendarUrl } from "@/lib/calendar/ics";
import { contentDefaults } from "@/lib/content/defaults";
import type { Celebration, SiteContent } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";
import { renderRsvpConfirmation } from "./rsvp-confirmation";

const SITE_URL = "https://example.com";
const [first, second, third] = contentDefaults.celebrations;

function record(
  answers: RsvpRecord["answers"],
  fullName = "Ama Test",
): RsvpRecord {
  return {
    id: "r1",
    fullName,
    phone: "024 000 0000",
    email: "ama@example.com",
    partySize: "Just me",
    answers,
    receivedAt: "2026-10-29T09:41:07.123Z",
    supersededAt: null,
    emailStatus: "queued",
    flags: [],
  };
}

const render = (reply: RsvpRecord, content: SiteContent = contentDefaults) =>
  renderRsvpConfirmation(reply, content, SITE_URL);

/** Text as React writes it into html: these five characters escaped. */
const asHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

/** The html's text with its tags taken out, still escaped. */
const withoutTags = (html: string) => html.replace(/<[^>]*>/g, "");

/** "Saturday 5 December". */
const weekdayDate = (celebration: Celebration) =>
  `${celebration.weekday} ${Number(celebration.day)} ${celebration.month}`;

/** One celebration's card: from its name to the next answered one's, or to the change note. */
function card(body: string, celebration: Celebration, next: Celebration | null): string {
  const start = body.indexOf(celebration.name);
  expect(start).toBeGreaterThan(-1);
  const end = next
    ? body.indexOf(next.name, start + celebration.name.length)
    : body.indexOf("Need to change something?", start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

describe("renderRsvpConfirmation", () => {
  it("keeps the subject", async () => {
    const mail = await render(record({ [first.id]: "yes" }));
    expect(mail.subject).toBe("Your reply to Noblet & Nancy");
  });

  it("shows each answered celebration's name, day, time, place and answer, in the html and the text", async () => {
    const mail = await render(record({ [first.id]: "yes", [second.id]: "no" }));
    for (const [body, written] of [
      [mail.html, asHtml],
      [mail.text, (value: string) => value],
    ] as const) {
      const attending = card(body, first, second);
      const notAttending = card(body, second, null);
      for (const [segment, celebration] of [
        [attending, first],
        [notAttending, second],
      ] as const) {
        expect(segment).toContain(written(weekdayDate(celebration)));
        expect(segment).toContain(written(celebration.time));
        expect(segment).toContain(written(celebration.place));
      }
      expect(attending).toContain("Attending");
      expect(attending).not.toContain("Not attending");
      expect(notAttending).toContain("Not attending");
      expect(body).not.toContain(third.name);
    }
  });

  it("links only the celebrations the guest is coming to to Google Calendar, beside the attached file", async () => {
    const mail = await render(record({ [first.id]: "yes", [second.id]: "no" }));
    const comingTo = googleCalendarUrl(celebrationEvent(first, SITE_URL));
    const notComingTo = googleCalendarUrl(celebrationEvent(second, SITE_URL));
    expect(mail.html).toContain(`href="${asHtml(comingTo)}"`);
    expect(mail.text).toContain(comingTo);
    expect(mail.html).not.toContain(asHtml(notComingTo));
    expect(mail.text).not.toContain(notComingTo);
    for (const body of [mail.html, mail.text]) {
      expect(card(body, first, second)).toContain("Add to Google Calendar");
      expect(card(body, second, null)).not.toContain("Google Calendar");
      expect(body).toContain("calendar file attached to this email");
    }
  });

  it("builds a calendar file with the celebrations the guest is coming to only", async () => {
    const mail = await render(record({ [first.id]: "yes", [second.id]: "no" }));
    expect(mail.ics).toContain(`UID:${first.id}@nobletxnancy.com`);
    expect(mail.ics).not.toContain(`UID:${second.id}@nobletxnancy.com`);
  });

  it("links to the form, and carries the change note, the sign-off and the site's address", async () => {
    const mail = await render(record({ [first.id]: "yes" }));
    expect(mail.html).toContain(`href="${SITE_URL}/rsvp"`);
    expect(mail.html).toContain("Change my reply");
    expect(mail.text).toContain(`${SITE_URL}/rsvp`);
    expect(mail.html).toContain(`href="${SITE_URL}"`);
    for (const [body, written] of [
      [withoutTags(mail.html), asHtml],
      [mail.text, (value: string) => value],
    ] as const) {
      expect(body).toContain(
        written("Need to change something? Send a new reply with the same name and phone or email."),
      );
      expect(body).toContain(written("With love, Noblet & Nancy"));
      expect(body).toContain("example.com");
    }
    // The plain text ends on the site's address, said once.
    expect(mail.text.trim().split("\n").at(-1)).toBe("example.com");
  });

  it("uses only https links", async () => {
    const mail = await render(record({ [first.id]: "yes", [second.id]: "no" }));
    const htmlLinks = [...mail.html.matchAll(/(?<![\w-])(?:href|src)="([^"]*)"|url\(([^)]*)\)/g)].map(
      (match) => match[1] ?? match[2],
    );
    const textLinks = mail.text.match(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi) ?? [];
    expect(htmlLinks.length).toBeGreaterThan(0);
    expect(textLinks.length).toBeGreaterThan(0);
    for (const link of [...htmlLinks, ...textLinks]) expect(link).toMatch(/^https:\/\//);
  });

  it("renders a reply byte for byte the same on a retry, the calendar file stamped with the reply's time", async () => {
    const reply = record({ [first.id]: "yes", [second.id]: "no" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-29T09:41:08Z"));
      const firstTry = await render(reply);
      vi.setSystemTime(new Date("2026-11-02T18:30:00Z"));
      const retry = await render(reply);
      expect(retry).toEqual(firstTry);
      expect(firstTry.ics).toContain("DTSTAMP:20261029T094107Z\r\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("thanks a guest who can come to none, warmly, with no calendar links or file", async () => {
    const mail = await render(record({ [first.id]: "no", [second.id]: "no" }));
    for (const [body, written] of [
      [withoutTags(mail.html), asHtml],
      [mail.text, (value: string) => value],
    ] as const) {
      expect(body).toContain(written("We'll miss you"));
      expect(body).toContain("Not attending");
      expect(body).not.toContain("Attending");
      expect(body).not.toContain("Google Calendar");
      expect(body).not.toContain("calendar file");
      expect(body).toContain(written("With love, Noblet & Nancy"));
    }
    expect(mail.html).not.toContain("calendar.google.com");
    expect(mail.html).toContain(`href="${SITE_URL}/rsvp"`);
    expect(mail.ics).toBeNull();
  });

  it("escapes the guest's name and the couple's text in the html", async () => {
    const content: SiteContent = {
      ...contentDefaults,
      celebrations: contentDefaults.celebrations.map((celebration) =>
        celebration.id === first.id
          ? { ...celebration, name: 'Church <b>"hall"</b>', place: "Hall <img src=x> & garden" }
          : celebration,
      ),
    };
    const mail = await render(record({ [first.id]: "yes" }, "Ama O'Brien"), content);
    expect(mail.html).toContain("Dear Ama O&#x27;Brien,");
    expect(mail.text).toContain("Dear Ama O'Brien,");
    expect(mail.html).toContain("Church &lt;b&gt;&quot;hall&quot;&lt;/b&gt;");
    expect(mail.html).toContain("Hall &lt;img src=x&gt; &amp; garden");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).not.toContain("<img");
  });

  it.each(["Ama Owusu", "Akosua Ɔfori", "J. Doe", "Kwame Mensah Jr."])(
    "greets %s by name",
    async (name) => {
      const mail = await render(record({ [first.id]: "yes" }, name));
      expect(mail.text).toContain(`Dear ${name},`);
      expect(mail.html).toContain(`Dear ${name},`);
    },
  );

  it.each([
    "see http://evil.test",
    "visit www.evil.test",
    "a@evil.test",
    "bit.ly",
    "evil.com",
    "a.b.c",
    "пример.рф",
    "A".repeat(61),
  ])("greets a guest whose name is %s as a guest", async (name) => {
    const mail = await render(record({ [first.id]: "yes" }, name));
    expect(mail.text).toContain("Dear guest,");
    expect(mail.html).toContain("Dear guest,");
    expect(mail.text).not.toContain(name);
    expect(mail.html).not.toContain(name);
  });
});
