"use client";

import { useEffect, useRef } from "react";
import { placeholderUrl } from "@/components/album/placeholder";
import { badgeOf, shortTimeWords, tileTimeWords, type AdminItem } from "@/lib/media/admin-item";
import { clockTime } from "@/lib/media/album-item";
import { AdminIcon } from "./AdminIcon";

/** The worker's thumbnail is 480 px wide: width and height keep the tile from shifting as it loads. */
const THUMB_WIDTH = 480;

/**
 * An item's square (gate B): its thumbnail (a video's poster) over its colour and ThumbHash, or, for
 * a hidden or removed item whose public files are gone, the ThumbHash alone (Ruling BV); a failed
 * item with nothing to show, a striped square with an alert. Its one badge, a video's length and a
 * highlight's star sit on it. The ThumbHash is decoded in the browser once the page runs.
 */
export function AdminThumb({ item, eager }: { item: AdminItem; eager: boolean }) {
  const square = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!item.thumbhash || !square.current) return;
    const url = placeholderUrl(item.thumbhash);
    if (url) square.current.style.backgroundImage = `url(${url})`;
  }, [item.thumbhash]);

  const badge = badgeOf(item);
  const height = item.width && item.height ? Math.round((THUMB_WIDTH * item.height) / item.width) : THUMB_WIDTH;
  const nothing = !item.thumb && !item.thumbhash;
  return (
    <span ref={square} className="admin-thumb" style={item.color ? { backgroundColor: item.color } : undefined}>
      {item.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
        <img src={item.thumb} alt="" width={THUMB_WIDTH} height={height} loading={eager ? "eager" : "lazy"} decoding="async" />
      ) : nothing ? (
        <span className="admin-nothumb">
          <AdminIcon name="alert" size={22} />
        </span>
      ) : null}
      {badge ? (
        <span className={`admin-badge admin-badge-${badge.tone}`} title={badge.panel}>
          <span className="admin-badge-text">{badge.tile}</span>
        </span>
      ) : null}
      {item.kind === "video" && item.seconds !== null ? (
        <span className="admin-length">
          <AdminIcon name="play" size={10} />
          {clockTime(item.seconds)}
        </span>
      ) : null}
      {item.highlight ? (
        <span className="admin-star" title="Highlight">
          <AdminIcon name="star-fill" size={14} />
        </span>
      ) : null}
    </span>
  );
}

/** The tile's name for a screen reader: "Video from Ama Owusu, Hidden, Reception, 5 Dec, 19:47". */
export function tileLabel(item: AdminItem, celebrationName: string): string {
  const badge = badgeOf(item);
  return [
    `${item.kind === "video" ? "Video" : "Photo"} from ${item.by ?? "a guest"}`,
    badge?.panel,
    item.highlight ? "highlighted" : null,
    celebrationName,
    shortTimeWords(item.takenAt ?? item.uploadedAt),
  ]
    .filter(Boolean)
    .join(", ");
}

/** One tile of the grid: its square, who shared it, and its celebration and time. Tapping it opens the panel. */
export function AdminTile({
  item,
  celebrationName,
  selected,
  eager,
  onSelect,
}: {
  item: AdminItem;
  celebrationName: string;
  selected: boolean;
  eager: boolean;
  onSelect: (item: AdminItem, tile: HTMLButtonElement) => void;
}) {
  const withdrawn = item.state === "hidden" || item.state === "removed";
  return (
    <li data-item={item.id}>
      <button
        type="button"
        className={`admin-tile${withdrawn ? " is-withdrawn" : ""}${item.state === "processing" ? " is-processing" : ""}`}
        aria-pressed={selected}
        aria-label={tileLabel(item, celebrationName)}
        onClick={(event) => onSelect(item, event.currentTarget)}
      >
        <AdminThumb item={item} eager={eager} />
        <span className="admin-tile-name">{item.by ?? "A guest"}</span>
        <span className="admin-tile-when">
          {celebrationName} · {tileTimeWords(item.takenAt ?? item.uploadedAt)}
        </span>
      </button>
    </li>
  );
}
