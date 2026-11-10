import { Img, Section } from "react-email";
import { HEADER_IMAGE } from "./header-image";
import { colours, fonts } from "./theme";

/** The banner's size as shown; the file is twice that for sharp screens. */
const WIDTH = 600;
const HEIGHT = 430;

/**
 * The header: the pre-wedding shoot with "Sat 5 Dec" and 05·12 in glass behind the couple, fading
 * into the blush page at its sides and bottom, from `design/email-header` and served from the site
 * under an address named after its content, so no cache keeps showing an earlier header.
 * Where images are blocked, the blush ground and the alt text stand in for it. Left out of the
 * plain-text part.
 */
export function Header({ siteUrl }: { siteUrl: string }) {
  return (
    <Section data-skip-in-text style={{ backgroundColor: colours.blush }}>
      <Img
        src={`${siteUrl}${HEADER_IMAGE}`}
        width={WIDTH}
        height={HEIGHT}
        alt="Noblet & Nancy · Saturday 5 December 2026 · Tepa"
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
