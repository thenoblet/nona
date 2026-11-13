import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ZOOM,
  escapeHtml,
  fitPadding,
  googleMapsEmbedUrl,
  googleMapsSearchUrl,
  panToShow,
  pinHtml,
  popupHtml,
  usableMaxZoom,
  type MapPlace,
} from "./venue-map";

const church: MapPlace = {
  number: 1,
  label: "Church",
  name: "Assemblies of God, Victory Worship Centre",
  lat: 7.019267,
  lng: -2.145361,
  directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=7.019267,-2.145361",
};

const hostile: MapPlace = {
  ...church,
  label: `<img src=x onerror="alert(1)">`,
  name: `St Mary's "Hall" & <script>alert(1)</script>`,
  directionsUrl: `https://example.com/?a=1&b="><script>alert(1)</script>`,
};

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and in quoted attributes", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it("leaves plain text alone", () => {
    expect(escapeHtml("BN 111 Katakyie St")).toBe("BN 111 Katakyie St");
  });
});

describe("pinHtml", () => {
  it("is a button named with the tag it shows and then the place, showing its number and its tag", () => {
    const html = pinHtml(church);
    expect(html).toMatch(/^<button type="button" class="nona-pin" aria-label="Church: Assemblies of God, Victory Worship Centre" aria-expanded="false">/);
    expect(html).toContain("<svg");
    expect(html).toContain('<span class="nona-pin__n">1</span>');
    expect(html).toContain('<span class="nona-pin__tag">Church</span>');
    expect(html).toMatch(/<\/button>$/);
  });

  it("escapes the name and the tag", () => {
    const html = pinHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain(
      'aria-label="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;: St Mary&#39;s &quot;Hall&quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    expect(html).toContain('<span class="nona-pin__tag">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span>');
  });
});

describe("popupHtml", () => {
  it("starts hidden, with the eyebrow, the name and a directions link that opens in a new tab", () => {
    expect(popupHtml(church)).toBe(
      '<div class="nona-pop" hidden>' +
        '<span class="nona-pop__eyebrow">Church</span>' +
        '<strong class="nona-pop__name">Assemblies of God, Victory Worship Centre</strong>' +
        '<a class="nona-pop__link" href="https://www.google.com/maps/dir/?api=1&amp;destination=7.019267,-2.145361" target="_blank" rel="noopener noreferrer">Get directions</a>' +
        "</div>",
    );
  });

  it("escapes the name, the eyebrow and the link", () => {
    const html = popupHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain('<strong class="nona-pop__name">St Mary&#39;s &quot;Hall&quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;</strong>');
    expect(html).toContain('href="https://example.com/?a=1&amp;b=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});

describe("googleMapsSearchUrl", () => {
  it("searches Google Maps for the place's coordinates", () => {
    expect(googleMapsSearchUrl(church)).toBe("https://www.google.com/maps/search/?api=1&query=7.019267,-2.145361");
  });

  it("searches for Tepa when no place has a pin", () => {
    expect(googleMapsSearchUrl(undefined)).toBe("https://www.google.com/maps/search/?api=1&query=Tepa%2C%20Ghana");
  });
});

describe("googleMapsEmbedUrl", () => {
  it("is Google's keyless embed of the place's coordinates, in satellite, in English", () => {
    const url = googleMapsEmbedUrl(church);
    expect(url).toBe("https://maps.google.com/maps?q=7.019267,-2.145361&t=k&z=17&hl=en&output=embed");
    const query = new URL(url).searchParams;
    expect(query.get("q")).toBe("7.019267,-2.145361");
    expect(query.get("t")).toBe("k");
    expect(query.get("output")).toBe("embed");
  });

  it("shows Tepa when no place has a pin", () => {
    expect(googleMapsEmbedUrl(undefined)).toBe("https://maps.google.com/maps?q=Tepa%2C%20Ghana&t=k&z=15&hl=en&output=embed");
  });
});

describe("fitPadding", () => {
  const frame = { top: 1000, right: 332, bottom: 1290, left: 100 };
  const hidden = { top: 0, right: 0, bottom: 0, left: 0 };

  it("keeps the usual room, more on the right for the name tags, when nothing lies over the map", () => {
    expect(fitPadding(frame, [], [])).toEqual({ top: 60, right: 110, bottom: 24, left: 24 });
  });

  it("keeps the pins, tall as they are, below what lies over the top and above what lies over the bottom", () => {
    const pill = { top: 1012, right: 320, bottom: 1056, left: 115 };
    const note = { top: 1173, right: 320, bottom: 1258, left: 158 };
    // 56 px of pill, a 44 px pin and 8 px to spare; 117 px of note and 8 to spare.
    expect(fitPadding(frame, [pill], [note])).toEqual({ top: 108, right: 110, bottom: 125, left: 24 });
  });

  it("ignores what is hidden, which has no size", () => {
    const pill = { top: 1012, right: 320, bottom: 1056, left: 115 };
    expect(fitPadding(frame, [hidden, pill], [hidden])).toEqual({ top: 108, right: 110, bottom: 24, left: 24 });
  });
});

describe("panToShow", () => {
  const frame = { top: 100, right: 500, bottom: 600, left: 100 };
  const margin = { top: 12, right: 12, bottom: 12, left: 12 };

  it("doesn't move the map when the popup is already inside the frame, margin included", () => {
    expect(panToShow({ top: 112, right: 488, bottom: 588, left: 112 }, frame, margin)).toEqual({ x: 0, y: 0 });
  });

  it("moves the map down when the popup runs off the top", () => {
    expect(panToShow({ top: 80, right: 300, bottom: 180, left: 200 }, frame, margin)).toEqual({ x: 0, y: -32 });
  });

  it("moves the map up when the popup runs off the bottom", () => {
    expect(panToShow({ top: 520, right: 300, bottom: 620, left: 200 }, frame, margin)).toEqual({ x: 0, y: 32 });
  });

  it("moves the map sideways when the popup runs off either side", () => {
    expect(panToShow({ top: 200, right: 530, bottom: 300, left: 330 }, frame, margin)).toEqual({ x: 42, y: 0 });
    expect(panToShow({ top: 200, right: 190, bottom: 300, left: 90 }, frame, margin)).toEqual({ x: -22, y: 0 });
  });

  it("keeps each side's own margin, such as more at the top for the map's controls", () => {
    const underControls = { top: 60, right: 12, bottom: 12, left: 12 };
    expect(panToShow({ top: 130, right: 300, bottom: 230, left: 200 }, frame, underControls)).toEqual({ x: 0, y: -30 });
    expect(panToShow({ top: 160, right: 300, bottom: 260, left: 200 }, frame, underControls)).toEqual({ x: 0, y: 0 });
  });

  it("keeps the popup's top left corner in view when it is bigger than the frame", () => {
    expect(panToShow({ top: 90, right: 520, bottom: 620, left: 90 }, frame, margin)).toEqual({ x: -22, y: -22 });
  });
});

describe("usableMaxZoom", () => {
  it("takes the zoom Google has imagery to", () => {
    expect(usableMaxZoom(19)).toBe(19);
    expect(usableMaxZoom(16)).toBe(16);
  });

  it("falls back to a safe zoom when there is no usable answer", () => {
    for (const answer of [undefined, null, Number.NaN, 0, -3, 2.5]) {
      expect(usableMaxZoom(answer)).toBe(DEFAULT_MAX_ZOOM);
    }
  });
});
