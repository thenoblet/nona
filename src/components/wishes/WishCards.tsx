import type { CSSProperties, ReactNode } from "react";
import type { Wish } from "@/lib/data/types";
import { couple } from "@/content/wedding";
import { Icon } from "@/components/ui/Icon";
import { PendingWish, VideoPlayer, VoicePlayer } from "./WishPlayers";
import type { WishCardStyle } from "./wish-styles";

export { pickWishStyles, type WishCardStyle } from "./wish-styles";

const cardShadow = "shadow-[0_1px_2px_rgb(61_41_39/0.06),0_12px_28px_rgb(61_41_39/0.08)]";
/** A ticket's edge and perforation, as in the confirmation email. */
const ticketEdge = "border-[#f1d5c2]";

/** Ghana keeps GMT all year, so the wall shows the time as it was at the venue. */
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Africa/Accra",
});

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Accra" });

function When({ iso, className = "" }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} className={`shrink-0 text-xs ${className}`}>
      {timeFormat.format(new Date(iso)).replace(",", " ·")}
    </time>
  );
}

/** The sender's name in script; give it its size and colour. */
function Signature({ name, className }: { name: string; className: string }) {
  return (
    <span className={`min-w-0 font-script break-words ${className}`}>
      <span className="sr-only">From </span>
      {name}
    </span>
  );
}

/** The wish's words, in the serif italic every paper shares; give it its size and colour. */
function Words({ children, className }: { children: ReactNode; className: string }) {
  return <p className={`m-0 font-serif break-words whitespace-pre-line italic ${className}`}>{children}</p>;
}

/** The first letter of the sender's name, for a seal or a ticket stub. */
function initialOf(name: string): string {
  const letter = [...name].find((character) => /\p{L}/u.test(character));
  return (letter ?? name.trim().charAt(0)).toUpperCase();
}

const tilt = (degrees: number): CSSProperties => ({ transform: `rotate(${degrees}deg)` });

/**
 * A written wish on its paper (pickWishStyles chooses it): a letter, a taped note, a keepsake, a
 * postcard, a ticket, a sealed envelope, or for a few words the big ember card.
 */
export function TextWish({ wish, style }: { wish: Wish; style: WishCardStyle }) {
  const message = wish.message ?? "";
  switch (style) {
    case "short":
      return (
        <article
          className="paper-card rounded-[var(--radius-paper)] bg-ember px-5.5 pt-6.5 pb-4.5 text-center shadow-[0_1px_2px_rgb(61_41_39/0.06),0_12px_28px_rgb(232_127_57/0.25)]"
          style={tilt(-0.8)}
        >
          <p className="m-0 font-script text-[46px] leading-[1.15] break-words text-cocoa">{message.trim()}</p>
          <footer className="mt-3 text-[11px] font-medium tracking-[0.24em] break-words text-cocoa uppercase">
            <span className="sr-only">From </span>
            {wish.signedAs} ·{" "}
            <time dateTime={wish.createdAt}>{dayFormat.format(new Date(wish.createdAt))}</time>
          </footer>
        </article>
      );

    case "taped":
      return (
        <article
          className={`paper-card relative mt-3 rounded-[2px] bg-white px-5.5 pt-7.5 pb-4.5 ${cardShadow}`}
          style={{
            ...tilt(0.9),
            // Ruled like notepaper: one 29 px tile per line of the words, its rule just under the words'
            // baseline (the words start 30 px down).
            backgroundImage: "linear-gradient(to bottom, transparent 28px, #f3e6df 28px)",
            backgroundSize: "100% 29px",
            backgroundPosition: "0 27px",
          }}
        >
          <span aria-hidden className="absolute -top-3 left-1/2 h-6.5 w-24 -translate-x-1/2 -rotate-3 bg-ember/40" />
          <Words className="text-[19px] leading-[29px]">{message}</Words>
          <footer className="mt-3 flex items-baseline justify-between gap-3">
            <Signature name={wish.signedAs} className="text-2xl text-mocha" />
            <When iso={wish.createdAt} className="text-mocha" />
          </footer>
        </article>
      );

    case "keepsake":
      return (
        <article
          className="paper-card rounded-[var(--radius-paper)] bg-cocoa p-2 shadow-[0_1px_2px_rgb(61_41_39/0.1),0_16px_34px_rgb(61_41_39/0.22)]"
          style={tilt(0.6)}
        >
          <div className="flex flex-col items-center border border-ember/55 px-4.5 pt-5 pb-3.5 text-center">
            <Icon name="heart" size={22} strokeWidth={1.6} className="text-ember" />
            <Words className="mt-2 text-xl leading-normal text-linen">{message}</Words>
            <Signature name={wish.signedAs} className="mt-3 text-[26px] text-ember" />
            <When iso={wish.createdAt} className="mt-0.5 tracking-[0.14em] text-mist" />
          </div>
        </article>
      );

    case "postcard":
      return (
        <article
          className={`paper-card rounded-[var(--radius-paper)] border border-hairline bg-white px-5 pt-4.5 pb-4 ${cardShadow}`}
          style={tilt(-0.4)}
        >
          <div aria-hidden className="float-right mb-2 ml-3.5 h-19 w-16 border-2 border-dashed border-ember p-[3px]">
            <div className="flex size-full flex-col items-center justify-center gap-0.5 bg-blush">
              <span className="font-script text-[18px] leading-none whitespace-nowrap text-ember">{couple.monogram.replaceAll(" ", "")}</span>
              <span className="text-[8px] font-medium tracking-[0.16em] text-cocoa">NONA&apos;26</span>
            </div>
          </div>
          <p aria-hidden className="m-0 mb-1.5 text-[10px] font-medium tracking-[0.24em] break-words text-ember-ink uppercase">
            Greetings from {wish.signedAs}
          </p>
          <Words className="text-[19px] leading-normal">{message}</Words>
          <footer className="clear-both mt-2.5 flex items-baseline justify-between gap-3 border-t border-hairline pt-2">
            <Signature name={wish.signedAs} className="text-[22px] text-mocha" />
            <When iso={wish.createdAt} className="text-mocha" />
          </footer>
        </article>
      );

    case "ticket":
      return (
        <article className={`paper-card flex rounded-xl border bg-white ${ticketEdge} ${cardShadow}`} style={tilt(0.5)}>
          <div
            aria-hidden
            className={`flex w-16 shrink-0 flex-col items-center justify-center gap-0.5 border-r-2 border-dashed py-3.5 ${ticketEdge}`}
          >
            <span className="font-script text-4xl leading-none text-ember">{initialOf(wish.signedAs)}</span>
            <span className="text-[10px] tracking-[0.22em] text-mocha uppercase">{dayFormat.format(new Date(wish.createdAt))}</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-4 pt-3.5 pb-3">
            <Words className="text-[19px] leading-[1.45]">{message}</Words>
            <footer className="flex items-baseline justify-between gap-3">
              <Signature name={wish.signedAs} className="text-[22px] text-mocha" />
              <When iso={wish.createdAt} className="sr-only" />
            </footer>
          </div>
        </article>
      );

    case "envelope":
      return (
        <article
          className={`paper-card relative overflow-hidden rounded-[var(--radius-paper)] bg-tray px-6.5 pt-[104px] pb-4.5 text-center ${cardShadow}`}
          style={tilt(-0.5)}
        >
          {/* The flap, folded down, and its wax seal with the sender's initial. */}
          <svg aria-hidden width="100%" height="70" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute top-0 left-0 block">
            <polygon points="0,0 100,0 50,100" fill="#eadbd1" />
            <polyline points="0,0 50,100 100,0" fill="none" stroke="#dcc7bb" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
          </svg>
          <span
            aria-hidden
            className="absolute top-11 left-1/2 flex size-13 -translate-x-1/2 items-center justify-center rounded-full bg-ember shadow-[0_3px_8px_rgb(180_86_27/0.35),inset_0_0_0_4px_rgb(255_255_255/0.18)]"
          >
            <span className="font-script text-[30px] leading-none text-cocoa">{initialOf(wish.signedAs)}</span>
          </span>
          <Words className="text-[21px] leading-[1.45]">{message}</Words>
          <Signature name={wish.signedAs} className="mt-3 block text-2xl text-mocha" />
          <When iso={wish.createdAt} className="block text-mocha" />
        </article>
      );

    case "letter":
      return (
        <article className={`paper-card rounded-[var(--radius-paper)] bg-blush px-5.5 pt-4.5 pb-4 ${cardShadow}`} style={tilt(-0.6)}>
          <span aria-hidden className="block h-10 font-serif text-[84px] leading-[0.7] text-ember italic">
            “
          </span>
          <Words className="text-[19px] leading-[1.55]">{message}</Words>
          <footer className="mt-3.5 flex items-baseline justify-between gap-3 border-t border-hairline pt-2.5">
            <Signature name={wish.signedAs} className="text-2xl text-mocha" />
            <When iso={wish.createdAt} className="text-mocha" />
          </footer>
        </article>
      );
  }
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
