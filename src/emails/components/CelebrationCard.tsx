import type { CSSProperties } from "react";
import { Column, Heading, Link, Row, Section, Text } from "react-email";
import { colours, fonts } from "./theme";

/** One celebration the guest answered, as the email shows it. */
export type ConfirmationCelebration = {
  id: string;
  name: string;
  /** "Saturday 5 December". */
  date: string;
  /** The time as guests see it, e.g. "Right after the white wedding · dinner & dancing". */
  time: string;
  place: string;
  placeDetail?: string;
  attending: boolean;
  /** Set for a celebration the guest is coming to, null otherwise. */
  googleCalendarUrl: string | null;
};

const detail: CSSProperties = {
  margin: 0,
  overflowWrap: "break-word",
  fontFamily: fonts.sans,
  fontSize: "15px",
  lineHeight: "23px",
  color: colours.mocha,
};

const pill: CSSProperties = {
  display: "inline-block",
  padding: "5px 11px",
  borderRadius: "999px",
  borderWidth: "1px",
  borderStyle: "solid",
  fontFamily: fonts.sans,
  fontSize: "10px",
  lineHeight: "14px",
  fontWeight: 500,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  verticalAlign: "middle",
};

/** A white card: the celebration's name and the guest's answer, then when and where. */
export function CelebrationCard({ celebration }: { celebration: ConfirmationCelebration }) {
  return (
    <Section style={{ paddingTop: "14px" }}>
      <Section
        className="nn-card"
        style={{
          backgroundColor: colours.white,
          border: `1px solid ${colours.hairline}`,
          borderRadius: "3px",
          borderCollapse: "separate",
        }}
      >
        <Row>
          {/* The name and the answer flow as one line, so on a narrow screen the answer drops under the name. */}
          <Column style={{ padding: "20px 22px 0", fontSize: "24px", lineHeight: "30px" }}>
            <Heading
              as="h2"
              className="nn-ink"
              style={{
                display: "inline",
                margin: 0,
                paddingRight: "6px",
                fontFamily: fonts.serif,
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: "24px",
                lineHeight: "30px",
                color: colours.cocoa,
                overflowWrap: "break-word",
              }}
            >
              {celebration.name}
            </Heading>{" "}
            {celebration.attending ? (
              <span
                className="nn-yes"
                style={{ ...pill, backgroundColor: colours.halo, borderColor: colours.ember, color: colours.cocoa }}
              >
                Attending
              </span>
            ) : (
              <span
                className="nn-no"
                style={{ ...pill, backgroundColor: colours.white, borderColor: colours.stone, color: colours.mocha }}
              >
                Not attending
              </span>
            )}
          </Column>
        </Row>
        <Row>
          <Column style={{ padding: "10px 22px 22px" }}>
            {/* One paragraph with line breaks, so the plain-text part keeps these lines together. */}
            <Text className="nn-soft" style={detail}>
              <span className="nn-ink" style={{ color: colours.cocoa, fontWeight: 500 }}>
                {celebration.date}
              </span>
              <br />
              {celebration.time}
              <br />
              {celebration.place}
              {celebration.placeDetail ? (
                <>
                  <br />
                  <span style={{ fontSize: "13px" }}>{celebration.placeDetail}</span>
                </>
              ) : null}
            </Text>
            {celebration.googleCalendarUrl ? (
              <Text style={{ margin: "16px 0 0", lineHeight: "20px" }}>
                <Link
                  href={celebration.googleCalendarUrl}
                  className="nn-link"
                  style={{
                    color: colours.cocoa,
                    borderBottom: `1px solid ${colours.ember}`,
                    paddingBottom: "2px",
                    fontFamily: fonts.sans,
                    fontSize: "12px",
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    textDecoration: "none",
                  }}
                >
                  Add to Google Calendar
                </Link>
              </Text>
            ) : null}
          </Column>
        </Row>
      </Section>
    </Section>
  );
}
