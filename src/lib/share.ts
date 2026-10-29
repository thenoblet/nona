import type { Metadata } from "next";

/**
 * Link preview settings every page shares. A page that sets its own `openGraph`
 * replaces the parent's whole object, so pages spread this in and add their own
 * title, description and url. The preview images come from the opengraph-image
 * files next to each page.
 */
export const shareDefaults = {
  type: "website",
  siteName: "Noblet & Nancy",
  locale: "en_GB",
} satisfies Metadata["openGraph"];
