import type { StaticImageData } from "next/image";
import kiss from "../../public/images/story/kiss.jpg";
import embraceBw from "../../public/images/story/embrace-bw.jpg";
import bouquet from "../../public/images/story/bouquet.jpg";
import nancySmile from "../../public/images/story/nancy-smile.jpg";
import howWeMetBw from "../../public/images/story/how-we-met-bw.jpg";
import earlyDays from "../../public/images/story/early-days.jpg";
import chrysanthemumsWide from "../../public/images/flowers/chrysanthemums-wide.jpg";
import chrysanthemumsPortrait from "../../public/images/flowers/chrysanthemums-portrait.jpg";
import daisiesWrapped from "../../public/images/flowers/daisies-wrapped.jpg";

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
  nancySmile: { src: nancySmile, alt: "Nancy smiling", position: "center 25%" },
  howWeMetBw: { src: howWeMetBw, alt: "Noblet and Nancy in their early days, in black and white", position: "center 30%" },
  earlyDays: { src: earlyDays, alt: "A playful selfie of Noblet and Nancy on a basketball court", position: "center 40%" },
  chrysanthemumsWide: { src: chrysanthemumsWide, alt: "A soft close-up of white chrysanthemums", position: "center 45%" },
  chrysanthemumsPortrait: { src: chrysanthemumsPortrait, alt: "A bouquet of white chrysanthemums", position: "30% 40%" },
  daisiesWrapped: {
    src: daisiesWrapped,
    alt: "A bouquet of white daisies and baby's breath wrapped in white paper",
    position: "center 45%",
  },
} satisfies Record<string, Photo>;
