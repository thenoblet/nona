"use client";

import type { Entrance, PlaylistView } from "./playlist";
import { SlideImage } from "./SlideImage";

const entranceAnimation: Record<Entrance, string> = {
  fade: "animate-slide-fade",
  forward: "animate-slide-forward",
  back: "animate-slide-back",
};

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
          <SlideImage slide={slide} decorative loading="eager" className="scale-110 opacity-50 blur-2xl" />
          <SlideImage
            slide={slide}
            loading="eager"
            fit="contain"
            fetchPriority={role === "current" ? "high" : undefined}
            // A photo that broke before the page woke up reports a load with no size.
            onLoad={(image) => (image.naturalWidth > 0 ? onLoaded(slide.id) : onFailed(slide.id))}
            onError={() => onFailed(slide.id)}
          />
        </div>
      ))}
    </div>
  );
}
