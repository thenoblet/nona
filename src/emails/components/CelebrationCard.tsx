import type { CSSProperties } from "react";
import { Column, Heading, Link, Row, Section, Text } from "react-email";
import { colours, fonts } from "./theme";

/** One celebration the guest answered, as the email shows it. */
export type ConfirmationCelebration = {
  id: string;
  name: string;
  /** "Saturday 5 December". */
  date: string;
  /** The day as the ticket's stub shows it: "Sat", "05", "Dec". */
  stub: { weekday: string; day: string; month: string };
  /** The time as guests see it, e.g. "Right after the white wedding · dinner & dancing". */
  time: string;
  /** "BN 111 Katakyie St, Tepa". */
  place: string;
  /** "GhanaPost GPS · AX-0084-3317", or null while the venue's GPS is still to confirm. */
  gpsLine: string | null;
  /** An extra note under the GPS line, such as "Main hall, upstairs". */
  placeDetail?: string;
  attending: boolean;
  /** Set for a celebration the guest is coming to, null otherwise. */
  googleCalendarUrl: string | null;
};

const smallCaps: CSSProperties = {
  fontFamily: fonts.sans,
  fontSize: "10px",
  lineHeight: "16px",
  fontWeight: 500,
  letterSpacing: "0.26em",
  textTransform: "uppercase",
};

const GPS_SEPARATOR = " · ";

/**
 * "GhanaPost GPS · AX-0084-3317", free to wrap on a narrow phone, but only before the code: the
 * code itself stays whole (it breaks at its hyphens otherwise), so a guest can read it off as typed.
 */
function GpsLine({ line }: { line: string }) {
  const separator = line.lastIndexOf(GPS_SEPARATOR);
  if (separator === -1) return <>{line}</>;
  const codeStart = separator + GPS_SEPARATOR.length;
  return (
    <>
      {line.slice(0, codeStart)}
      <span style={{ whiteSpace: "nowrap" }}>{line.slice(codeStart)}</span>
    </>
  );
}

/**
 * One celebration as a keepsake ticket: a stub with the day, a dashed perforation, then the name,
 * the guest's answer, when and where, and a Google Calendar link. A celebration they're coming to
 * has an ember-tinted edge; the rest are quieter. The stub repeats the date, so the plain-text
 * part leaves it out.
 */
export function CelebrationCard({ celebration }: { celebration: ConfirmationCelebration }) {
  const coming = celebration.attending;
  const edge = coming ? colours.ticket : colours.ticketAway;
  // A day the couple wrote as words ("[Day]") is too wide for the stub's large figures.
  const numericDay = /^\d{1,2}$/.test(celebration.stub.day);
  return (
    <Section
      style={{
        marginBottom: "14px",
        backgroundColor: colours.white,
        border: `1px solid ${edge}`,
        borderRadius: "14px",
        borderCollapse: "separate",
      }}
    >
      <Row>
        <Column
          className="nn-stub"
          data-skip-in-text
          aria-hidden="true"
          style={{ width: "86px", padding: "22px 0", verticalAlign: "middle", textAlign: "center", borderRight: `2px dashed ${edge}` }}
        >
          <Text style={{ ...smallCaps, margin: 0, color: coming ? colours.emberInk : colours.mocha }}>{celebration.stub.weekday}</Text>
          <Text
            style={{
              margin: "2px 0",
              fontFamily: fonts.text,
              fontSize: numericDay ? "38px" : "16px",
              lineHeight: "42px",
              color: coming ? colours.cocoa : colours.stone,
            }}
          >
            {celebration.stub.day}
          </Text>
          <Text style={{ ...smallCaps, margin: 0, color: colours.mocha }}>{celebration.stub.month}</Text>
        </Column>
        <Column className="nn-ticket" style={{ padding: "20px 22px 22px", verticalAlign: "top" }}>
          {/* The name comes first, the answer under it, so the plain text keeps each answer with its celebration. */}
          <Heading
            as="h2"
            style={{
              margin: 0,
              overflowWrap: "break-word",
              fontFamily: fonts.serif,
              fontStyle: "italic",
              fontWeight: 500,
              fontSize: "25px",
              lineHeight: "30px",
              color: coming ? colours.cocoa : colours.mocha,
            }}
          >
            {celebration.name}
          </Heading>
          <Text style={{ ...smallCaps, margin: "6px 0 0", color: coming ? colours.emberInk : colours.mocha }}>
            {coming ? "Attending" : "Not attending"}
          </Text>
          {/* One paragraph with line breaks, so the plain-text part keeps these lines together. */}
          <Text
            style={{ margin: "8px 0 0", overflowWrap: "break-word", fontFamily: fonts.text, fontSize: "14px", lineHeight: "22px", color: colours.mocha }}
          >
            <span style={{ color: coming ? colours.cocoa : colours.mocha }}>{celebration.date}</span>
            <br />
            {celebration.time}
            <br />
            {celebration.place}
            {celebration.gpsLine ? (
              <>
                <br />
                <GpsLine line={celebration.gpsLine} />
              </>
            ) : null}
            {celebration.placeDetail ? (
              <>
                <br />
                {celebration.placeDetail}
              </>
            ) : null}
          </Text>
          {celebration.googleCalendarUrl ? (
            <Text style={{ margin: "12px 0 0", lineHeight: "20px" }}>
              <Link
                href={celebration.googleCalendarUrl}
                style={{
                  ...smallCaps,
                  letterSpacing: "0.16em",
                  whiteSpace: "nowrap",
                  color: colours.cocoa,
                  textDecoration: "none",
                  borderBottom: `1px solid ${colours.ember}`,
                  paddingBottom: "3px",
                }}
              >
                Add to Google Calendar
              </Link>
            </Text>
          ) : null}
        </Column>
      </Row>
    </Section>
  );
}
