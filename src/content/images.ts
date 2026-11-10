import type { StaticImageData } from "next/image";
import kiss from "../../public/images/story/kiss.jpg";
import embraceBw from "../../public/images/story/embrace-bw.jpg";
import bouquet from "../../public/images/story/bouquet.jpg";
import howWeMetBw from "../../public/images/story/how-we-met-bw.jpg";
import earlyDays from "../../public/images/story/early-days.jpg";
import dressedUp from "../../public/images/story/dressed-up.jpg";
import chrysanthemumsWide from "../../public/images/flowers/chrysanthemums-wide.jpg";
import chrysanthemumsPortrait from "../../public/images/flowers/chrysanthemums-portrait.jpg";
import daisiesWrapped from "../../public/images/flowers/daisies-wrapped.jpg";
import lilian from "../../public/images/party/lilian.jpg";
import james from "../../public/images/party/james.jpg";
import dennis from "../../public/images/party/dennis.jpg";
import afrifa from "../../public/images/party/afrifa.jpg";
import homeHero from "../../public/images/home/hero.jpg";

export type Photo = { src: StaticImageData; alt: string; position?: string };

/** Static imports give next/image the real size and a blur placeholder. */
export const photos = {
  kiss: { src: kiss, alt: "Noblet and Nancy share a kiss beneath a rose arch", position: "center 30%" },
  embraceBw: {
    src: embraceBw,
    alt: "Noblet and Nancy embrace beneath a neon Marry Me sign, in black and white",
    position: "center 45%",
  },
  bouquet: { src: bouquet, alt: "Nancy holds her bouquet and the ring as they hug", position: "center 20%" },
  howWeMetBw: { src: howWeMetBw, alt: "Noblet and Nancy in their early days, in black and white", position: "center 30%" },
  // Straightened from a tilted shot and cropped to the small print's portrait shape, around both faces.
  // Cropped from inside its white frame to the small print's portrait shape.
  dressedUp: { src: dressedUp, alt: "A selfie of Nancy in yellow lace and Noblet in a navy suit", position: "center 30%" },
  earlyDays: { src: earlyDays, alt: "Noblet and Nancy, Nancy peeking past his shoulder, on a basketball court", position: "center 35%" },
  chrysanthemumsWide: { src: chrysanthemumsWide, alt: "A soft close-up of white chrysanthemums", position: "center 45%" },
  chrysanthemumsPortrait: { src: chrysanthemumsPortrait, alt: "A bouquet of white chrysanthemums", position: "30% 40%" },
  daisiesWrapped: {
    src: daisiesWrapped,
    alt: "A bouquet of white daisies and baby's breath wrapped in white paper",
    position: "center 45%",
  },
} satisfies Record<string, Photo>;

/**
 * The photo behind the names at the top of the home page. To change it, replace
 * public/images/home/hero.jpg with the new photo under the same name: nothing else to edit.
 *
 * - A landscape JPEG, about 2000 to 3000 px wide and under 3 MB, so it loads quickly on a phone.
 * - Faces in the upper middle: phones show a tall slice from the centre, cropped from the
 *   `position` below (across, then down). If a new photo needs a different crop, set its focal
 *   point in Admin › Site photos › Home hero ("Using the built-in photo", then the focal point);
 *   no code needed. A photo uploaded there instead replaces this one without a deploy.
 * - It sits under a cocoa wash with the names over it, so it is never read aloud.
 */
export const homeHeroPhoto: Photo = { src: homeHero, alt: "Noblet and Nancy", position: "center 28%" };

/** Wedding party portraits, keyed by the member `id` in `party` (src/content/wedding.ts). */
export const partyPhotos: Partial<Record<string, Photo>> = {
  lilian: { src: lilian, alt: "Lilian, maid of honour", position: "center 40%" },
  james: { src: james, alt: "James, best man", position: "center 30%" },
  dennis: { src: dennis, alt: "Dennis, groomsman", position: "center 30%" },
  afrifa: { src: afrifa, alt: "Afrifa, groomsman", position: "center 30%" },
};

/*
 * These are the built-in photos. The couple replace any of them from the admin (Site photos,
 * src/lib/site-images/), and the site shows these until they do.
 */

/** Photos behind the link preview cards: plain paths in public/, in their own file so the media worker can bundle it. */
export { previewPhotos } from "./preview-photos";
