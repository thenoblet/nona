import { rgbaToThumbHash } from "thumbhash";

/*
 * An item's placeholder, shown while its thumbnail loads: a ThumbHash (about 25 bytes, which the
 * album sends raw and the phone decodes into a blurred preview) and the average colour, which the
 * tile can show before any script runs. The media worker makes both from a copy of the photo or
 * poster at most 100 px on its long edge. Pure, with no Node APIs, so the album's client code can
 * share this file.
 */

/** The longest edge ThumbHash takes. */
export const PLACEHOLDER_MAX_EDGE = 100;

export type Placeholder = {
  /** The raw ThumbHash, in base64. */
  thumbhash: string;
  /** "#rrggbb". */
  averageColor: string;
};

function hexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

/** The mean colour of the pixels that show, each weighted by its opacity; of them all if none does. */
function averageColorOf(rgba: Uint8Array): string {
  const totals = { red: 0, green: 0, blue: 0, weight: 0 };
  const plain = { red: 0, green: 0, blue: 0 };
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const opacity = rgba[offset + 3] / 255;
    totals.red += rgba[offset] * opacity;
    totals.green += rgba[offset + 1] * opacity;
    totals.blue += rgba[offset + 2] * opacity;
    totals.weight += opacity;
    plain.red += rgba[offset];
    plain.green += rgba[offset + 1];
    plain.blue += rgba[offset + 2];
  }
  const [red, green, blue] =
    totals.weight > 0
      ? [totals.red / totals.weight, totals.green / totals.weight, totals.blue / totals.weight]
      : [plain.red, plain.green, plain.blue].map((total) => total / (rgba.length / 4));
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}

/**
 * The placeholder of an image `width` × `height` pixels, at most 100 on each side, given as
 * unpremultiplied RGBA, row by row.
 */
export function placeholderOf(width: number, height: number, rgba: Uint8Array): Placeholder {
  if (width < 1 || height < 1 || width > PLACEHOLDER_MAX_EDGE || height > PLACEHOLDER_MAX_EDGE) {
    throw new RangeError(`A placeholder is made from at most ${PLACEHOLDER_MAX_EDGE} × ${PLACEHOLDER_MAX_EDGE} pixels, not ${width} × ${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`Expected ${width * height * 4} bytes of RGBA, not ${rgba.length}`);
  }
  const hash = rgbaToThumbHash(width, height, rgba);
  return {
    thumbhash: btoa(String.fromCharCode(...hash)),
    averageColor: averageColorOf(rgba),
  };
}
