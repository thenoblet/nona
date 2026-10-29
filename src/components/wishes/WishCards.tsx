import Image from "next/image";
import { photos } from "@/content/images";
import type { Wish } from "@/lib/data/types";
import { PlayGlyph } from "@/components/ui/Icon";

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

/** A fixed two-tone waveform: played part in ember, the rest in mist. */
const bars = [6, 14, 8, 18, 10, 4, 16, 10, 6, 20, 12, 6, 14, 8, 16, 4, 12, 8, 18, 10, 6, 14, 8, 12, 4];

function Waveform() {
  return (
    <svg width="100%" height="22" viewBox="0 0 200 22" preserveAspectRatio="none" aria-hidden>
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * 8}
          y={(22 - h) / 2}
          width="3"
          height={h}
          rx="1.5"
          fill={i < 8 ? "var(--color-ember)" : "var(--color-mist)"}
        />
      ))}
    </svg>
  );
}

export function VoiceWish({ wish, index }: { wish: Wish; index: number }) {
  return (
    <article
      className={`paper-card flex items-center gap-3.5 rounded-full bg-white py-2.5 pr-5.5 pl-2.5 ${cardShadow}`}
      style={{ transform: `rotate(${index % 2 ? -0.5 : 0.5}deg)` }}
    >
      <button
        type="button"
        aria-label={`Play voice note from ${wish.signedAs}`}
        // TODO: play the voice note from S3.
        className="press flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)]"
      >
        <PlayGlyph size={16} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Waveform />
        <p className="m-0 truncate text-xs text-mocha">
          {wish.signedAs} · voice note{wish.duration ? ` · ${wish.duration}` : ""}
        </p>
      </div>
    </article>
  );
}

export function VideoWish({ wish, index }: { wish: Wish; index: number }) {
  const thumb = photos.chrysanthemumsWide;
  return (
    <article
      className={`paper-card flex flex-col rounded-[var(--radius-paper)] bg-white px-2 pt-2 ${cardShadow}`}
      style={{ transform: `rotate(${index % 2 ? 0.4 : -0.4}deg)` }}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-tile">
        <Image
          src={thumb.src}
          alt=""
          fill
          sizes="(min-width: 640px) 560px, 100vw"
          placeholder="blur"
          className="object-cover"
          style={{ objectPosition: thumb.position }}
        />
        <button
          type="button"
          aria-label={`Play video message from ${wish.signedAs}`}
          // TODO: play the video message from S3, using its own poster frame.
          className="absolute inset-0 flex cursor-pointer items-center justify-center"
        >
          <span className="press flex size-14 items-center justify-center rounded-full bg-white/95 text-cocoa shadow-[0_4px_14px_rgb(61_41_39/0.2)]">
            <PlayGlyph size={18} />
          </span>
        </button>
      </div>
      <footer className="flex items-baseline justify-between gap-3 px-2.5 pt-3 pb-3.5">
        <span className="min-w-0 font-script text-[22px] break-words text-mocha">{wish.signedAs}</span>
        <span className="shrink-0 text-xs text-mocha">video{wish.duration ? ` · ${wish.duration}` : ""}</span>
      </footer>
    </article>
  );
}
