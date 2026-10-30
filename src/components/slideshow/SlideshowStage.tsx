"use client";

import { MediaImage } from "@/components/album/MediaImage";
import type { Entrance, PlaylistView } from "./playlist";

const entranceAnimation: Record<Entrance, string> = {
  fade: "animate-slide-fade",
  forward: "animate-slide-forward",
  back: "animate-slide-back",
};

/** The photo spans a phone's width, and about two thirds of the TV frame. */
const PHOTO_SIZES = "(orientation: landscape) and (min-width: 700px) 68vw, 100vw";

/**
 * The photos. The current one comes in over the one before it, and the next one waits
 * invisible underneath, so it has loaded by the time its turn comes. Nothing else is
 * mounted. Each layer shows the whole photo over a soft, blurred copy that fills the frame,
 * on an opaque ground so layers never show through each other.
 */
export function SlideshowStage({
  layers,
  entrance,
  onLoaded,
  onFailed,
}: {
  layers: PlaylistView["layers"];
  entrance: Entrance;
  onLoaded: (id: string) => void;
  onFailed: (id: string) => void;
}) {
  // TODO: play videos muted inline instead of showing their poster frame.
  return (
    <div className="absolute inset-0 isolate bg-inherit">
      {layers.map(({ slide, role }) => (
        <div
          key={slide.id}
          aria-hidden={role !== "current"}
          className={`absolute inset-0 overflow-hidden bg-inherit ${
            role === "current" ? `z-20 ${entranceAnimation[entrance]}` : role === "previous" ? "z-10" : "z-0 opacity-0"
          }`}
        >
          <MediaImage item={{ ...slide, alt: "" }} sizes="20vw" loading="eager" className="scale-110 opacity-50 blur-2xl" />
          <MediaImage
            item={slide}
            sizes={PHOTO_SIZES}
            loading="eager"
            fit="contain"
            fetchPriority={role === "current" ? "high" : undefined}
            // A photo that broke before the page woke up reports a load with no size.
            onLoad={(event) => (event.currentTarget.naturalWidth > 0 ? onLoaded(slide.id) : onFailed(slide.id))}
            onError={() => onFailed(slide.id)}
          />
        </div>
      ))}
    </div>
  );
}
