// The guest site's look, in what email clients accept: inline colours, font stacks that read
// well when the web fonts never load (Gmail strips them), and the few rules that need a style block.

export const colours = {
  cocoa: "#3D2927",
  mocha: "#6A524C",
  ember: "#E87F39",
  /** Orange text that passes contrast on light grounds (the site's ember-ink). */
  emberInk: "#B4561B",
  /** The page: the colour the header photo fades into, so picture and letter are one surface. */
  blush: "#F7EFEA",
  white: "#FFFFFF",
  /** A ticket's edge and perforation for a celebration the guest is coming to: ember, softened. */
  ticket: "#F1D5C2",
  /** The same for one they aren't. */
  ticketAway: "#EDE4DF",
  /** The day on the stub of a celebration they aren't coming to. */
  stone: "#DCCDC6",
} as const;

export const fonts = {
  /** Italic display only: the only Cormorant face loaded is italic, so upright text uses `text`. */
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  /** Upright reading text. Georgia is on every client, so the letter reads the same everywhere. */
  text: "Georgia, 'Times New Roman', serif",
  /** Set in italic: Georgia italic stands in where Pinyon Script can't load. */
  script: "'Pinyon Script', Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
} as const;

/**
 * Web fonts for the clients that load them (Apple Mail, iOS Mail, Outlook for Mac). Pinyon Script
 * is declared italic, so the italic that gives Georgia its slant leaves the script upright.
 * `mso-font-alt` keeps Outlook for Windows on Georgia rather than Times.
 */
export const fontFaces = `
@font-face {
  font-family: 'Cormorant Garamond';
  font-style: italic;
  font-weight: 500;
  mso-font-alt: 'Georgia';
  src: url(https://fonts.gstatic.com/s/cormorantgaramond/v21/co3ZmX5slCNuHLi8bLeY9MK7whWMhyjYrEtImSo.woff2) format('woff2');
}
@font-face {
  font-family: 'Pinyon Script';
  font-style: italic;
  font-weight: 400;
  mso-font-alt: 'Georgia';
  src: url(https://fonts.gstatic.com/s/pinyonscript/v24/6xKpdSJbL9-e9LuoeQiDRQR8WOXaOg.woff2) format('woff2');
}
`;

/**
 * The email stays light: the header photo fades into the blush page, and a dark page would cut
 * it off with a hard edge. `light only` keeps Apple Mail and Outlook for Mac from darkening it.
 * Also keeps iOS from turning dates and places into blue links, and narrows the margins on phones:
 * `nn-pad` and `nn-ticket` sit on the cells that carry the padding (a Section's `tdClassName`), so
 * on a phone 16 px replaces their padding rather than adding to it. Kept apart from the font
 * faces: a client that rejects one style block keeps the other.
 */
export const clientStyles = `
:root { color-scheme: light only; supported-color-schemes: light; }
a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
@media only screen and (max-width: 480px) {
  .nn-pad { padding-left: 16px !important; padding-right: 16px !important; }
  .nn-stub { width: 54px !important; }
  .nn-ticket { padding-left: 14px !important; padding-right: 14px !important; }
  /* "Noblet & Nancy" stays on one line: in Georgia, where the script font can't load, 36 px is too wide for 320 px. */
  .nn-sign { font-size: 27px !important; line-height: 34px !important; }
}
`;
