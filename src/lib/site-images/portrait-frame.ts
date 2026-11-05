/**
 * Frames a wedding-party portrait the way the site's ovals show them: head and shoulders at 3:4,
 * the top of the head the same share down every portrait, the head about half the frame's height.
 * For photos already cut out onto one flat background colour (the blush the portraits share), as
 * supplied: the subject is whatever differs from that colour. Used by scripts/party-portrait.ts;
 * pure, so it is tested without files.
 */

export type RawImage = { data: Uint8Array; width: number; height: number; channels: number };

export type PortraitFrame = {
  /** The photo's background colour, read from its top corners. */
  background: [number, number, number];
  /** The head's top row, the row where the shoulders start, and its centre column. */
  head: { top: number; bottom: number; centre: number };
  /**
   * The 3:4 crop, in the photo's pixels. It may start above or beside the photo (negative top or
   * left) or end past its right edge: the caller pads those with the background colour. It never
   * ends below the photo, where the subject is cut off.
   */
  crop: { left: number; top: number; width: number; height: number };
};

/** How far down the frame the top of the head sits. */
export const PORTRAIT_HEADROOM = 0.12;
/** The head's height (top to shoulders) as a share of the frame's height, room permitting. */
const HEAD_SHARE = 0.46;
/** How far a pixel's colour may stray from the background (summed over R, G and B) and still be it. */
const BACKGROUND_TOLERANCE = 40;
/** The shoulders start where the subject first grows this much wider than the head above it. */
const SHOULDER_GROWTH = 1.35;
/** The size of the corner patches the background colour is read from. */
const CORNER_PATCH = 8;

function pixelAt(image: RawImage, column: number, row: number): [number, number, number] {
  const offset = (row * image.width + column) * image.channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function distance(colour: readonly number[], other: readonly number[]): number {
  return Math.abs(colour[0] - other[0]) + Math.abs(colour[1] - other[1]) + Math.abs(colour[2] - other[2]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

function cornerColour(image: RawImage, fromColumn: number): [number, number, number] {
  const sums = [0, 0, 0];
  for (let row = 0; row < CORNER_PATCH; row += 1) {
    for (let column = fromColumn; column < fromColumn + CORNER_PATCH; column += 1) {
      pixelAt(image, column, row).forEach((value, channel) => (sums[channel] += value));
    }
  }
  const count = CORNER_PATCH * CORNER_PATCH;
  return [Math.round(sums[0] / count), Math.round(sums[1] / count), Math.round(sums[2] / count)];
}

/** Each row's subject: its leftmost and rightmost columns, or null where the row is all background. */
function subjectSpans(image: RawImage, background: readonly number[]): ({ left: number; right: number } | null)[] {
  const spans: ({ left: number; right: number } | null)[] = [];
  for (let row = 0; row < image.height; row += 1) {
    const columns: number[] = [];
    for (let column = 0; column < image.width; column += 1) {
      if (distance(pixelAt(image, column, row), background) > BACKGROUND_TOLERANCE) columns.push(column);
    }
    // A few stray pixels (noise, a compression speck) aren't the subject.
    spans.push(columns.length >= 3 ? { left: columns[0], right: columns[columns.length - 1] } : null);
  }
  return spans;
}

export function framePortrait(image: RawImage): PortraitFrame {
  const leftCorner = cornerColour(image, 0);
  const rightCorner = cornerColour(image, image.width - CORNER_PATCH);
  if (distance(leftCorner, rightCorner) > BACKGROUND_TOLERANCE / 2) {
    throw new Error("The photo needs one flat background colour: its top corners differ. Cut the subject out onto the blush first.");
  }
  const background: [number, number, number] = [
    Math.round((leftCorner[0] + rightCorner[0]) / 2),
    Math.round((leftCorner[1] + rightCorner[1]) / 2),
    Math.round((leftCorner[2] + rightCorner[2]) / 2),
  ];

  const spans = subjectSpans(image, background);
  const headTop = spans.findIndex((span) => span !== null);
  if (headTop === -1) throw new Error("There is no one in the photo: every pixel is the background colour.");

  // Walk down from the head until the subject grows much wider than the head so far: the shoulders.
  // The first stretch (a fifth of what lies below the head's top) is head whatever its width does.
  const widths: number[] = [];
  let headBottom = image.height;
  const headAtLeast = Math.round((image.height - headTop) / 5);
  for (let row = headTop; row < image.height; row += 1) {
    const span = spans[row];
    const width = span ? span.right - span.left : 0;
    if (row - headTop >= headAtLeast && width > SHOULDER_GROWTH * median(widths)) {
      headBottom = row;
      break;
    }
    widths.push(width);
  }

  // The head's centre, from the middle of its rows (the crown and the chin lean less on it).
  const headRows = spans.slice(headTop + Math.round((headBottom - headTop) / 4), headBottom - Math.round((headBottom - headTop) / 4));
  const centres = headRows.flatMap((span) => (span ? [(span.left + span.right) / 2] : []));
  const headCentre = Math.round(median(centres));

  // The head about half the frame, but never so loose that the frame runs past the photo's bottom.
  const headHeight = headBottom - headTop;
  const height = Math.round(Math.min(headHeight / HEAD_SHARE, (image.height - headTop) / (1 - PORTRAIT_HEADROOM)));
  const width = Math.round((height * 3) / 4);
  const top = Math.round(headTop - PORTRAIT_HEADROOM * height);
  const left = Math.round(headCentre - width / 2);

  return { background, head: { top: headTop, bottom: headBottom, centre: headCentre }, crop: { left, top, width, height } };
}
