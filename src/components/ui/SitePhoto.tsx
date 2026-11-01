import Image from "next/image";
import type { CSSProperties } from "react";
import { preload } from "react-dom";
import type { SlotPhoto } from "@/lib/site-images/photos";

/*
 * One of the site's own photos (a slot): its built-in photo through next/image, as before, or the
 * couple's replacement from the worker's own WebP sizes on MEDIA_BASE_URL, never through Next's
 * image optimiser (Ruling CI): explicit width and height, a srcset of the sizes the slot can use,
 * and the focal point as its object-position. `fill` covers the parent, as next/image's does.
 */
export function SitePhoto({
  photo,
  sizes,
  className,
  style,
  fill = false,
  priority = false,
  blur = false,
  decorative = false,
}: {
  photo: SlotPhoto;
  sizes: string;
  className?: string;
  style?: CSSProperties;
  fill?: boolean;
  /** The page's main photo: loaded first, never lazily. */
  priority?: boolean;
  /** next/image's blur placeholder, for a built-in photo; the couple's shows its average colour instead. */
  blur?: boolean;
  /** A photo behind text: screen readers skip it. */
  decorative?: boolean;
}) {
  const alt = decorative ? "" : photo.alt;
  if (photo.kind === "builtin") {
    return (
      <Image
        src={photo.image}
        alt={alt}
        fill={fill}
        sizes={sizes}
        priority={priority}
        placeholder={blur ? "blur" : undefined}
        className={className}
        style={{ objectPosition: photo.position, ...style }}
      />
    );
  }

  const srcSet = photo.sources.map((source) => `${source.url} ${source.width}w`).join(", ");
  // For a browser that ignores srcset: the widest the slot lists.
  const src = photo.sources[photo.sources.length - 1].url;
  if (priority) preload(src, { as: "image", imageSrcSet: srcSet, imageSizes: sizes, fetchPriority: "high" });
  const fillStyle: CSSProperties = fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : {};
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the worker's own sizes, never Next's optimiser (Ruling CI)
    <img
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      width={photo.width}
      height={photo.height}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      data-site-photo=""
      className={className}
      style={{ ...fillStyle, objectPosition: photo.position, backgroundColor: photo.averageColor ?? undefined, ...style }}
    />
  );
}
