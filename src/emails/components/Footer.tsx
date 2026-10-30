import { Link, Section, Text } from "react-email";
import { colours, fonts } from "./theme";

const small = {
  margin: 0,
  textAlign: "center",
  fontFamily: fonts.sans,
  fontSize: "10px",
  lineHeight: "16px",
  fontWeight: 500,
  letterSpacing: "0.26em",
  textTransform: "uppercase",
} as const;

/** The last lines: the wedding's hashtag, then the site's address, e.g. "nobletxnancy.com". */
export function Footer({ siteUrl }: { siteUrl: string }) {
  return (
    <Section style={{ paddingTop: "30px" }}>
      <Text style={{ ...small, color: colours.emberInk }}>#NONA26</Text>
      <Text style={{ ...small, marginTop: "6px", fontSize: "12px", fontWeight: 400, letterSpacing: "0.14em", textTransform: "none" }}>
        <Link href={siteUrl} data-text-without-href style={{ color: colours.mocha, textDecoration: "none" }}>
          {siteUrl.replace(/^https?:\/\//, "")}
        </Link>
      </Text>
    </Section>
  );
}
