import "server-only";
import { connection } from "next/server";
import QRCode from "qrcode";
import { siteUrl } from "@/lib/site-url";

/**
 * The shared album's public address, for QR codes on the venue screen and table cards.
 * Waits for a real request so SITE_URL is read at runtime, not baked in at build time.
 * Call it from inside a <Suspense> boundary.
 */
export async function albumUrl(): Promise<string> {
  await connection();
  return `${siteUrl()}/album`;
}

/** The album URL without the scheme, for printing as text. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * A QR code as an SVG string: cocoa modules on white, no quiet zone
 * (the caller frames it with white padding). Scales to its container.
 */
export async function qrSvg(text: string, label: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#3D2927", light: "#FFFFFF" },
  });
  const safeLabel = label.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  return svg.replace(
    "<svg ",
    `<svg role="img" aria-label="${safeLabel}" width="100%" height="100%" style="display:block" `,
  );
}
