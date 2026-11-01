/**
 * The built-in photos behind the link preview cards, as paths in public/: the cards are drawn from
 * the file itself, at build time by the opengraph-image files and, once the couple edit a card's
 * photo in the admin (Site photos), by the media worker, whose image carries these four files.
 * Plain data, with no image imports, so the worker can bundle it. The couple replace a card's
 * photo from the admin; to change a built-in one, swap the file here.
 */
export const previewPhotos = {
  invitation: {
    file: "images/story/embrace-bw.jpg",
    position: "center 45%",
    alt: "Noblet and Nancy embrace beneath a neon Marry Me sign, in black and white",
  },
  rsvp: { file: "images/story/bouquet.jpg", position: "center 20%", alt: "Nancy holds her bouquet and the ring as they hug" },
  album: { file: "images/story/kiss.jpg", position: "center 30%", alt: "Noblet and Nancy share a kiss beneath a rose arch" },
  wishes: { file: "images/story/nancy-smile.jpg", position: "center 25%", alt: "Nancy smiling" },
} satisfies Record<string, { file: string; position: string; alt: string }>;

/** The four link preview cards: the invitation (any page without its own), the RSVP, the album and the wishes. */
export type PreviewCardId = keyof typeof previewPhotos;

export const PREVIEW_CARD_IDS = Object.keys(previewPhotos) as PreviewCardId[];
