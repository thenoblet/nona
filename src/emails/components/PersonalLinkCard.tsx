import { Button, Column, Heading, Row, Section, Text } from "react-email";
import { colours, fonts } from "./theme";

const paragraph = {
  margin: 0,
  fontFamily: fonts.text,
  fontSize: "15px",
  lineHeight: "23px",
  textAlign: "center",
  color: colours.mocha,
} as const;

const smallCaps = {
  fontFamily: fonts.sans,
  fontSize: "10px",
  lineHeight: "16px",
  fontWeight: 500,
  letterSpacing: "0.26em",
  textTransform: "uppercase",
} as const;

/**
 * The guest's personal link, as a card like the album's own "Your personal link": the same name,
 * so the guest knows it again there, the ask to open it before sharing a first photo (Ruling CG),
 * and a button that opens it. The plain text keeps the heading, the line and the link's address.
 */
export function PersonalLinkCard({ link }: { link: string }) {
  return (
    <Section tdClassName="nn-pad" style={{ padding: "12px 34px 0" }}>
      <Section
        style={{
          backgroundColor: colours.white,
          border: `1px solid ${colours.ticket}`,
          borderRadius: "14px",
          borderCollapse: "separate",
        }}
      >
        <Row>
          <Column className="nn-ticket" style={{ padding: "14px 18px 16px", textAlign: "center" }}>
            <Heading
              as="h2"
              style={{
                margin: 0,
                textAlign: "center",
                fontFamily: fonts.serif,
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: "20px",
                lineHeight: "24px",
                color: colours.cocoa,
              }}
            >
              Your personal link
            </Heading>
            <Text style={{ ...paragraph, margin: "4px auto 12px", maxWidth: "340px", fontSize: "13px", lineHeight: "19px" }}>
              Open it on your phone before you share your first photo, so your photos stay together.
            </Text>
            <Button
              href={link}
              style={{
                ...smallCaps,
                fontSize: "10px",
                padding: "11px 22px",
                borderRadius: "999px",
                backgroundColor: colours.ember,
                color: colours.cocoa,
              }}
            >
              Open my link
            </Button>
          </Column>
        </Row>
      </Section>
    </Section>
  );
}

