import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheLife } from "next/cache";
import { ImageResponse } from "next/og";
import sharp from "sharp";

/*
 * Link preview cards (WhatsApp, iMessage, Facebook, X): one of the couple's photos
 * under a cocoa wash, a thin ember frame like the invitation card, and the script
 * title centred, so WhatsApp's square crop of the middle still reads.
 * Rendered once at build time. The preview renderer reads TTF only, so
 * src/fonts/og/ holds TTF subsets of the site's own fonts. The renderer supports a subset
 * of CSS: no `inset` shorthand, so layers use top/right/bottom/left.
 */

export const ogSize = { width: 1200, height: 630 };
// JPEG, not the renderer's PNG: a photo card as PNG is 250–800 KB, and WhatsApp skips
// preview images much over 300 KB.
export const ogContentType = "image/jpeg";

const COCOA = "#3D2927";
const EMBER = "#E87F39";
const LINEN = "#F3EBE8";
const MIST = "#D9CBC6";

const font = (file: string) => readFile(join(process.cwd(), "src/fonts/og", file));

// Read once when the module loads, so drawing a card does no file I/O and Next can
// prerender it at build time (I/O inside the handler would make it per-request).
const [pinyon, cormorant, cormorantItalic, jost, jostMedium] = await Promise.all([
  font("pinyon-script-400.ttf"),
  font("cormorant-garamond-500.ttf"),
  font("cormorant-garamond-400-italic.ttf"),
  font("jost-400.ttf"),
  font("jost-500.ttf"),
]);

/** A photo in public/ as a data URL. Call it at module level in the card's file, for the same reason. */
export async function loadPhoto(file: string) {
  const image = await readFile(join(process.cwd(), "public", file));
  return `data:image/jpeg;base64,${image.toString("base64")}`;
}

export type PreviewCard = {
  /** Small ember line above the title, as on the site's section headings. */
  eyebrow: string;
  /** Script title, one entry per line. Any "&" is set in ember. */
  title: string[];
  /** Serif line under the ornament. */
  line: string;
  /** Small spaced line at the foot. */
  sub: string;
  /** The background photo, from loadPhoto(), and its focal point. */
  photo: string;
  position?: string;
};

/** A script line with each "&" in ember, the way the site sets the couple's names. */
function ScriptLine({ text }: { text: string }) {
  const parts = text.split("&").map((p) => p.trim());
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 26 }}>
      {parts.map((part, i) => (
        <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 26 }}>
          {i > 0 ? <span style={{ color: EMBER }}>&amp;</span> : null}
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

export async function previewCard(card: PreviewCard) {
  return new Response(await renderJpeg(card), { headers: { "Content-Type": ogContentType } });
}

/** Cached so the cards are still prerendered at build time despite the async conversion. */
async function renderJpeg(card: PreviewCard) {
  "use cache";
  cacheLife("max");
  const png = await renderPng(card).arrayBuffer();
  return new Uint8Array(await sharp(Buffer.from(png)).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
}

function renderPng({ eyebrow, title, line, sub, photo, position = "center" }: PreviewCard) {
  return new ImageResponse(
    (
      <div style={{ position: "relative", display: "flex", width: "100%", height: "100%", background: COCOA }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- rendered to PNG, not to the page */}
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
            {title.map((t) => (
              <ScriptLine key={t} text={t} />
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
    ),
    {
      ...ogSize,
      fonts: [
        { name: "Pinyon", data: pinyon, weight: 400, style: "normal" },
        { name: "Cormorant", data: cormorant, weight: 500, style: "normal" },
        { name: "Cormorant", data: cormorantItalic, weight: 400, style: "italic" },
        { name: "Jost", data: jost, weight: 400, style: "normal" },
        { name: "Jost", data: jostMedium, weight: 500, style: "normal" },
      ],
    },
  );
}
