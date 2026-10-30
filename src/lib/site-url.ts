/**
 * The site's public address from SITE_URL, without a trailing slash, for QR codes, emails,
 * calendar files and link previews. Empty or unset (in development) it is http://localhost:3000.
 */
export function siteUrl(): string {
  return (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
}
