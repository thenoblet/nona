import type { ReactElement } from "react";

/*
 * The link preview card's layout (WhatsApp, iMessage, Facebook, X): one of the couple's photos under
 * a cocoa wash, a thin ember frame like the invitation card, and the script title centred, so
 * WhatsApp's square crop of the middle still reads. Drawn by satori in two places from this one
 * tree: at build time by Next (lib/og.tsx, the opengraph-image files), and by the media worker
 * (worker/jobs/card.ts) once the couple change a card's photo. Plain React elements with no Next.js
 * import, so the worker can bundle it. satori reads TTF only, so src/fonts/og/ holds TTF subsets of
 * the site's own fonts, and it supports a subset of CSS: no `inset` shorthand, so layers use
 * top/right/bottom/left.
 */

export const ogSize = { width: 1200, height: 630 };

const COCOA = "#3D2927";
const EMBER = "#E87F39";
const LINEN = "#F3EBE8";
const MIST = "#D9CBC6";

/** The card's fonts: its file in src/fonts/og/ and how the layout names it. */
export const CARD_FONTS = [
  { name: "Pinyon", file: "pinyon-script-400.ttf", weight: 400, style: "normal" },
  { name: "Cormorant", file: "cormorant-garamond-500.ttf", weight: 500, style: "normal" },
  { name: "Cormorant", file: "cormorant-garamond-400-italic.ttf", weight: 400, style: "italic" },
  { name: "Jost", file: "jost-400.ttf", weight: 400, style: "normal" },
  { name: "Jost", file: "jost-500.ttf", weight: 500, style: "normal" },
] as const;

/** The card's words. */
export type CardText = {
  /** Small ember line above the title, as on the site's section headings. */
  eyebrow: string;
  /** Script title, one entry per line. Any "&" is set in ember. */
  title: string[];
  /** Serif line under the ornament. */
  line: string;
  /** Small spaced line at the foot. */
  sub: string;
};

export type PreviewCard = CardText & {
  /** The background photo, as a data URL. */
  photo: string;
  /** Its object-position; the worker hands over a photo already cut to the card's size, so "center". */
  position?: string;
};

/** A script line with each "&" in ember, the way the site sets the couple's names. */
function ScriptLine({ text }: { text: string }) {
  const parts = text.split("&").map((part) => part.trim());
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 26 }}>
      {parts.map((part, index) => (
        <div key={index} style={{ display: "flex", alignItems: "baseline", gap: 26 }}>
          {index > 0 ? <span style={{ color: EMBER }}>&amp;</span> : null}
          {part ? <span>{part}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** The site's line–diamond–line ornament, with the centre dot. */
function Ornament() {
  return (
    <svg width="220" height="16" viewBox="0 0 220 16">
      <path d="M0 8h96M124 8h96" stroke={EMBER} strokeWidth="1.5" />
      <path d="M110 2l6 6-6 6-6-6z" fill="none" stroke={EMBER} strokeWidth="1.5" />
      <circle cx="110" cy="8" r="1.8" fill={EMBER} />
    </svg>
  );
}

/** The whole card, 1200 × 630. */
export function cardElement({ eyebrow, title, line, sub, photo, position = "center" }: PreviewCard): ReactElement {
  return (
    <div style={{ position: "relative", display: "flex", width: "100%", height: "100%", background: COCOA }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- drawn to an image, not to the page */}
      <img
        src={photo}
        alt=""
        width={ogSize.width}
        height={ogSize.height}
        style={{ position: "absolute", top: 0, left: 0, objectFit: "cover", objectPosition: position }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundImage: `linear-gradient(180deg, rgba(61,41,39,0.80) 0%, rgba(61,41,39,0.70) 45%, rgba(61,41,39,0.88) 100%)`,
        }}
      />
      <div style={{ position: "absolute", top: 28, right: 28, bottom: 28, left: 28, border: "1.5px solid rgba(232,127,57,0.55)" }} />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          color: "white",
        }}
      >
        <div
          style={{
            fontFamily: "Jost",
            fontWeight: 500,
            fontSize: 21,
            letterSpacing: 7,
            textTransform: "uppercase",
            color: EMBER,
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginTop: 14,
            fontFamily: "Pinyon",
            fontSize: title.length > 1 ? 104 : 118,
            lineHeight: 1.12,
          }}
        >
          {title.map((titleLine) => (
            <ScriptLine key={titleLine} text={titleLine} />
          ))}
        </div>
        <div style={{ display: "flex", marginTop: 22 }}>
          <Ornament />
        </div>
        <div style={{ marginTop: 22, fontFamily: "Cormorant", fontWeight: 500, fontSize: 42, color: LINEN }}>{line}</div>
        <div
          style={{
            marginTop: 10,
            fontFamily: "Jost",
            fontWeight: 400,
            fontSize: 19,
            letterSpacing: 5,
            textTransform: "uppercase",
            color: MIST,
          }}
        >
          {sub}
        </div>
      </div>
    </div>
  );
}
