import Image from "next/image";
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
}: {
  item: Pick<MediaItem, "src" | "alt" | "position">;
  sizes: string;
  className?: string;
  loading?: "eager" | "lazy";
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
      unoptimized={remote}
      placeholder={remote ? "empty" : "blur"}
      className={`object-cover ${className}`}
      style={{ objectPosition: item.position ?? "center" }}
    />
  );
}
