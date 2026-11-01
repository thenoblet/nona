import { useCallback, useEffect, useRef } from "react";
import { slideAlt, type Slide } from "./playlist";

/**
 * A slide's picture, filling its (relative, sized) parent, straight from the media domain: guest
 * media never goes through Next's image optimiser. Its width and height tell the browser its shape
 * before it loads, so nothing shifts.
 */
export function SlideImage({
  slide,
  decorative = false,
  fit = "cover",
  loading = "lazy",
  fetchPriority,
  className = "",
  onLoad,
  onError,
}: {
  slide: Slide;
  /** A copy behind the picture (the stage's blurred backdrop), which screen readers skip. */
  decorative?: boolean;
  /** "contain" shows the whole picture, centred (the stage); "cover" fills its box, cropping. */
  fit?: "cover" | "contain";
  loading?: "eager" | "lazy";
  fetchPriority?: "high" | "low" | "auto";
  className?: string;
  /** The picture is in: given the element, so the caller can tell a real picture from a broken one. */
  onLoad?: (image: HTMLImageElement) => void;
  onError?: () => void;
}) {
  // A picture that arrived before the page's script ran fired its load event unheard: it is told
  // when the element is first attached instead (a second telling changes nothing).
  const latestOnLoad = useRef(onLoad);
  useEffect(() => {
    latestOnLoad.current = onLoad;
  });
  const tellEarlyLoad = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete) latestOnLoad.current?.(image);
  }, []);

  return (
    // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
    <img
      ref={tellEarlyLoad}
      alt={decorative ? "" : slideAlt(slide)}
      width={slide.width ?? undefined}
      height={slide.height ?? undefined}
      // Before src: some browsers start a download as soon as src is set, lazy or not.
      loading={loading}
      decoding="async"
      fetchPriority={fetchPriority}
      src={slide.src}
      onLoad={(event) => onLoad?.(event.currentTarget)}
      onError={onError}
      // Transparent text: a picture that breaks shows no alt text over the stage.
      className={`absolute inset-0 size-full text-transparent ${fit === "contain" ? "object-contain" : "object-cover"} ${className}`}
    />
  );
}
