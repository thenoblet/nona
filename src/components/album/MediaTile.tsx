"use client";

import { useEffect, useRef } from "react";
import { Icon, PlayGlyph } from "@/components/ui/Icon";
import { clockTime, failureWords, type AlbumItem } from "@/lib/media/album-item";
import { placeholderUrl } from "./placeholder";

/** The thumbnail's own size: the worker makes it 480 px wide. Width and height let nothing shift as it loads. */
const THUMB_WIDTH = 480;

/** The tile's words for a screen reader: "Video shared by Ama", "Photo shared by you". */
function tileLabel(item: AlbumItem): string {
  return `${item.kind === "video" ? "Video" : "Photo"} shared by ${item.mine ? "you" : (item.by ?? "a guest")}`;
}

/**
 * One square in the album grid (gate A and B): a moment's thumbnail (a video's poster, with its
 * length), over its average colour and then its ThumbHash while the thumbnail loads, and an ember dot
 * on the guest's own. Tapping it opens the viewer. The guest's own moments not ready yet show
 * "Getting it ready"; a failed one says why, with Send again where sharing is open. New moments wear
 * an ember outline that fades.
 */
export function MediaTile({
  item,
  eager,
  fresh,
  onOpen,
  onSendAgain,
}: {
  item: AlbumItem;
  /** Above the fold: loaded at once rather than lazily. */
  eager: boolean;
  /** Just brought in by the pill. */
  fresh: boolean;
  onOpen: (item: AlbumItem, tile: HTMLElement) => void;
  onSendAgain: (() => void) | null;
}) {
  const tile = useRef<HTMLLIElement>(null);
  // The blurred preview, decoded on the phone once the page runs: the colour shows before it.
  useEffect(() => {
    if (!item.thumbhash || !tile.current) return;
    const url = placeholderUrl(item.thumbhash);
    if (url) tile.current.style.backgroundImage = `url(${url})`;
  }, [item.thumbhash]);

  const ready = item.status === "ready";
  const height = item.width && item.height ? Math.round((THUMB_WIDTH * item.height) / item.width) : THUMB_WIDTH;
  return (
    <li
      ref={tile}
      data-moment={item.id}
      className={`album-tile${fresh ? " is-fresh" : ""}`}
      style={item.color ? { backgroundColor: item.color } : undefined}
    >
      {ready ? (
        <button type="button" aria-label={tileLabel(item)} onClick={(event) => onOpen(item, event.currentTarget.parentElement as HTMLElement)}>
          {item.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
            <img src={item.thumb} alt="" width={THUMB_WIDTH} height={height} loading={eager ? "eager" : "lazy"} decoding="async" />
          ) : null}
        </button>
      ) : item.status === "failed" ? (
        <div className="album-tile-note bg-alert-tint text-alert">
          <Icon name="alert" size={18} strokeWidth={2} />
          <span>{failureWords(item.kind, item.failure)}</span>
          {onSendAgain ? (
            <button type="button" onClick={onSendAgain} className="album-tile-again">
              Send again
            </button>
          ) : null}
        </div>
      ) : (
        <div className="album-tile-note bg-blush text-mocha">
          <span className="album-tile-spin" aria-hidden />
          <span>Getting it ready</span>
        </div>
      )}
      {item.kind === "video" && ready ? (
        <span className="album-duration">
          <PlayGlyph size={9} />
          <span className="sr-only">Video{item.seconds !== null ? ", " : ""}</span>
          {item.seconds !== null ? clockTime(item.seconds) : null}
        </span>
      ) : null}
      {item.mine ? <span role="img" aria-label="Your upload" className="album-mine-dot" /> : null}
    </li>
  );
}
