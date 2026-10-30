import { Section, Text } from "react-email";
import { colours, fonts } from "./theme";

/** The "N & N" monogram with the site's orange ampersand. Left out of the plain-text part. */
export function Header() {
  return (
    <Section style={{ paddingBottom: "18px", textAlign: "center" }}>
      <Text
        className="nn-ink"
        data-skip-in-text
        style={{
          margin: 0,
          fontFamily: fonts.script,
          fontStyle: "italic",
          fontWeight: 400,
          fontSize: "44px",
          lineHeight: "56px",
          color: colours.cocoa,
        }}
      >
        N <span className="nn-accent" style={{ color: colours.emberInk }}>&amp;</span> N
      </Text>
    </Section>
  );
}
