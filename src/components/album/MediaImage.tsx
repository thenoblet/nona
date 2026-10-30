import Image, { type ImageProps } from "next/image";
import type { MediaItem } from "@/lib/data/types";

/**
 * Fills its (relative, sized) parent with a guest's photo or a video's poster.
 * - bundled image (StaticImageData): optimised, with a blur placeholder
 * - URL string: served as-is until the CloudFront host is added to `images.remotePatterns`
 * - null: no preview yet, the parent's `bg-tile` shows through
 */
export function MediaImage({
  item,
  sizes,
  className = "",
  loading,
  fit = "cover",
  fetchPriority,
  onLoad,
  onError,
}: {
  item: Pick<MediaItem, "src" | "alt" | "position">;
  sizes: string;
  className?: string;
  loading?: "eager" | "lazy";
  /** "contain" shows the whole photo, centred, for the slideshow stage. */
  fit?: "cover" | "contain";
  fetchPriority?: ImageProps["fetchPriority"];
  onLoad?: ImageProps["onLoad"];
  onError?: ImageProps["onError"];
}) {
  if (!item.src) {
    return <span className="sr-only">{item.alt} (preview not ready yet)</span>;
  }
  const remote = typeof item.src === "string";
  return (
    <Image
      src={item.src}
      alt={item.alt}
      fill
      sizes={sizes}
      loading={loading}
      fetchPriority={fetchPriority}
      unoptimized={remote}
      // No blur placeholder on a contained photo: next/image doesn't draw it to the photo's exact
      // shape, so it shows as bands beside the photo until the page has loaded its script. The
      // slideshow's blurred backdrop fills that space instead.
      placeholder={remote || fit === "contain" ? "empty" : "blur"}
      className={`${fit === "contain" ? "object-contain" : "object-cover"} ${className}`}
      // A contained photo is centred; the crop position only matters when it is cropped.
      style={{ objectPosition: fit === "contain" ? "center" : (item.position ?? "center") }}
      onLoad={onLoad}
      onError={onError}
    />
  );
}
