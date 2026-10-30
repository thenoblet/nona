import { Link, Section, Text } from "react-email";
import { colours, fonts } from "./theme";

/** The site's address under a hairline, e.g. "nobletxnancy.com". */
export function Footer({ siteUrl }: { siteUrl: string }) {
  return (
    <Section style={{ paddingTop: "36px" }}>
      <Section className="nn-rule" style={{ borderTop: `1px solid ${colours.hairline}`, paddingTop: "18px" }}>
        <Text
          style={{
            margin: 0,
            textAlign: "center",
            fontFamily: fonts.sans,
            fontSize: "12px",
            lineHeight: "18px",
            letterSpacing: "0.12em",
          }}
        >
          <Link
            href={siteUrl}
            className="nn-soft"
            data-text-without-href
            style={{ color: colours.mocha, textDecoration: "none" }}
          >
            {siteUrl.replace(/^https?:\/\//, "")}
          </Link>
        </Text>
      </Section>
    </Section>
  );
}
