import type { Wish } from "@/lib/data/types";
import { PendingWish, VideoPlayer, VoicePlayer } from "./WishPlayers";

const cardShadow = "shadow-[0_1px_2px_rgb(61_41_39/0.06),0_12px_28px_rgb(61_41_39/0.08)]";

/** Ghana keeps GMT all year, so the wall shows the time as it was at the venue. */
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Africa/Accra",
});

function When({ iso, className = "" }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} className={`shrink-0 text-xs ${className}`}>
      {timeFormat.format(new Date(iso)).replace(",", " ·")}
    </time>
  );
}

/** Text wishes cycle through three papers. */
const papers = [
  { card: "bg-blush", text: "", sign: "text-mocha", time: "text-mocha" },
  { card: "bg-white", text: "", sign: "text-mocha", time: "text-mocha" },
  { card: "bg-cocoa text-white", text: "text-linen", sign: "text-ember", time: "text-mist" },
] as const;

const tilts = [-0.8, 0.6, 0.7, -0.5, 0.4, -0.6];

export function TextWish({ wish, index }: { wish: Wish; index: number }) {
  const paper = papers[index % papers.length];
  return (
    <article
      className={`paper-card flex flex-col gap-3 rounded-[var(--radius-paper)] px-5.5 pt-6 pb-4.5 ${cardShadow} ${paper.card}`}
      style={{ transform: `rotate(${tilts[index % tilts.length]}deg)` }}
    >
      <p className={`m-0 font-serif text-[21px] leading-normal break-words italic ${paper.text}`}>
        <span className="text-ember" aria-hidden>
          “
        </span>
        {wish.message}
        <span className="text-ember" aria-hidden>
          ”
        </span>
      </p>
      <footer className="flex items-baseline justify-between gap-3">
        <span className={`min-w-0 font-script text-2xl break-words ${paper.sign}`}>
          <span className="sr-only">From </span>
          {wish.signedAs}
        </span>
        <When iso={wish.createdAt} className={paper.time} />
      </footer>
    </article>
  );
}

/**
 * A voice note on the wall: its player once the worker has made it, the sender's own "Getting your
 * wish ready…" before that (or its failure), never anyone else's (Ruling BR; listWishes decides).
 */
export function VoiceWish({ wish, index }: { wish: Wish; index: number }) {
  if (wish.recording) return <VoicePlayer wish={wish} recording={wish.recording} index={index} />;
  return <PendingWish wish={wish} index={index} />;
}

/** A video message on the wall: its poster and player once made, the sender's pending card before that. */
export function VideoWish({ wish, index }: { wish: Wish; index: number }) {
  if (wish.recording) return <VideoPlayer wish={wish} recording={wish.recording} index={index} />;
  return <PendingWish wish={wish} index={index} />;
}
