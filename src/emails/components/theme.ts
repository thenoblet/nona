// The guest site's look, in what email clients accept: inline colours, font stacks that read
// well when the web fonts never load (Gmail strips them), and classes for the dark-mode rules.

export const colours = {
  cocoa: "#3D2927",
  mocha: "#6A524C",
  ember: "#E87F39",
  /** Orange text that passes contrast on light grounds (the site's ember-ink). */
  emberInk: "#B4561B",
  blush: "#FAF6F4",
  white: "#FFFFFF",
  halo: "#FCEDE3",
  hairline: "#EADFDA",
  stone: "#DCCDC6",
} as const;

export const fonts = {
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
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
 * Dark mode for the clients that honour `prefers-color-scheme` (Apple Mail, iOS Mail, Outlook for
 * Mac), and keeps iOS from turning dates and places into blue links. Clients that invert colours
 * themselves (Gmail) drop this block and still read well, because every text colour sits on a
 * background colour of its own. Kept apart from the font faces: a client that rejects one style
 * block keeps the other.
 */
export const clientStyles = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
@media (prefers-color-scheme: dark) {
  .nn-page { background-color: #1F1614 !important; }
  .nn-card { background-color: #2C201D !important; border-color: #4A3833 !important; }
  .nn-ink { color: #F3EBE8 !important; }
  .nn-soft { color: #D9CBC6 !important; }
  .nn-accent { color: #F0A46F !important; }
  .nn-link { color: #F3EBE8 !important; border-bottom-color: #E87F39 !important; }
  .nn-yes { background-color: #4A2D1E !important; border-color: #E87F39 !important; color: #F3EBE8 !important; }
  .nn-no { background-color: #2C201D !important; border-color: #6A524C !important; color: #D9CBC6 !important; }
  .nn-button { background-color: #E87F39 !important; color: #3D2927 !important; }
  .nn-rule { border-color: #4A3833 !important; }
}
`;
