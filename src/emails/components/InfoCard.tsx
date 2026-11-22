import type { ReactNode } from "react";
import { Column, Heading, Row, Section } from "react-email";
import { colours, fonts } from "./theme";

/** A white card with an italic heading, like the celebrations' tickets: one topic of the email. */
export function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section tdClassName="nn-pad" style={{ padding: "14px 34px 0" }}>
      <Section
        style={{ backgroundColor: colours.white, border: `1px solid ${colours.ticket}`, borderRadius: "14px", borderCollapse: "separate" }}
      >
        <Row>
          <Column className="nn-ticket" style={{ padding: "16px 20px 14px" }}>
            <Heading
              as="h2"
              style={{
                margin: "0 0 6px",
                fontFamily: fonts.serif,
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: "22px",
                lineHeight: "26px",
                color: colours.cocoa,
              }}
            >
              {title}
            </Heading>
            {children}
          </Column>
        </Row>
      </Section>
    </Section>
  );
}
