import { Img, Section } from "react-email";
import { colours, fonts } from "./theme";

/** The banner's size as shown; the file is twice that for sharp screens. */
const WIDTH = 600;
const HEIGHT = 520;

/**
 * The header: the couple's embrace, fading into the blush page under "Noblet & Nancy" and the
 * dates, drawn from `design/email-header` and served from the site. Where images are blocked, the
 * blush ground and the alt text stand in for it. Left out of the plain-text part.
 */
export function Header({ siteUrl }: { siteUrl: string }) {
  return (
    <Section data-skip-in-text style={{ backgroundColor: colours.blush }}>
      <Img
        src={`${siteUrl}/email/header.jpg`}
        width={WIDTH}
        height={HEIGHT}
        alt="Noblet & Nancy · 5 & 6 December 2026 · Tepa"
        style={{
          display: "block",
          width: "100%",
          maxWidth: `${WIDTH}px`,
          height: "auto",
          border: 0,
          backgroundColor: colours.blush,
          color: colours.cocoa,
          fontFamily: fonts.serif,
          fontStyle: "italic",
          fontSize: "24px",
          lineHeight: "32px",
          textAlign: "center",
        }}
      />
    </Section>
  );
}
