import { PlayGlyph } from "@/components/ui/Icon";
import type { MediaItem } from "@/lib/data/types";
import { MediaImage } from "./MediaImage";

/** One square in the album grid: photo or video poster, video length, and a dot on your own uploads. */
export function MediaTile({ item, mine }: { item: MediaItem; mine: boolean }) {
  return (
    <li className="group relative aspect-square overflow-hidden rounded-[2px] bg-tile">
      <MediaImage
        item={item}
        sizes="(min-width: 1024px) 150px, (min-width: 768px) 190px, 33vw"
        className="transition-transform duration-600 ease-[cubic-bezier(0.2,0.7,0.2,1)] group-hover:scale-105"
      />
      {item.kind === "video" ? (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1.25 rounded-full bg-white/95 py-0.75 pr-2 pl-1.5 text-[11px] text-cocoa">
          <PlayGlyph size={9} />
          <span className="sr-only">Video, </span>
          {item.duration}
        </span>
      ) : null}
      {mine ? (
        <span
          role="img"
          aria-label="Your upload"
          className="absolute top-1.5 right-1.5 size-3 rounded-full border-2 border-white bg-ember"
        />
      ) : null}
    </li>
  );
}
