"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMusic } from "@/components/music/MusicProvider";

type Phase = "closed" | "breaking" | "open";
type Side = "left" | "right";

/** The seal splits along a jagged line; each half flies off its own way. */
const clips: Record<Side, string> = {
  left: "polygon(0 0, 53% 0, 46% 18%, 56% 36%, 45% 55%, 55% 74%, 48% 100%, 0 100%)",
  right: "polygon(53% 0, 100% 0, 100% 100%, 48% 100%, 55% 74%, 45% 55%, 56% 36%, 46% 18%)",
};
const flyAway: Record<Side, string> = {
  left: "translate(-30px, 18px) rotate(-24deg)",
  right: "translate(32px, 22px) rotate(20deg)",
};

function SealHalf({ side, breaking }: { side: Side; breaking: boolean }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex items-center justify-center rounded-full bg-ember font-script text-[clamp(22px,9.7cqw,32px)] text-cocoa shadow-[inset_0_0_0_5px_rgb(160_74_22/0.35),inset_0_0_0_8px_rgb(255_255_255/0.18)] transition-[transform,opacity] duration-[650ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      style={{
        clipPath: clips[side],
        transform: breaking ? flyAway[side] : "none",
        opacity: breaking ? 0 : 1,
      }}
    >
      N&amp;N
    </span>
  );
}

/**
 * The sealed envelope. Breaking the seal starts the music (the tap is the
 * gesture browsers ask for), then the invitation rises out.
 */
export function EnvelopeOpener({ invitation }: { invitation: ReactNode }) {
  const music = useMusic();
  const [phase, setPhase] = useState<Phase>("closed");
  const timer = useRef<number | undefined>(undefined);
  const openRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = timer;
    return () => window.clearTimeout(t.current);
  }, []);

  // The seal button is gone once open, so move focus to the invitation.
  useEffect(() => {
    if (phase === "open") openRef.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [phase]);

  function breakSeal() {
    if (phase !== "closed") return;
    music.play();
    setPhase("breaking");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = window.setTimeout(() => setPhase("open"), still ? 0 : 700);
  }

  if (phase === "open") {
    return (
      <div ref={openRef} className="flex w-full flex-col items-center">
        {invitation}
      </div>
    );
  }

  const breaking = phase === "breaking";
  return (
    <div className="flex w-full flex-col items-center">
      <h1 className="flex animate-rise flex-col items-center gap-2 text-center font-normal">
        <span className="text-xs uppercase tracking-[0.32em] text-ember">With love, to our</span>
        <span className="font-script text-[50px] leading-[1.2]">Family &amp; Friends</span>
      </h1>

      <div className="@container relative mt-15 aspect-[330/230] w-[330px] max-w-full animate-float rounded-[var(--radius-paper)] bg-blush shadow-[0_2px_4px_rgb(0_0_0/0.2),0_28px_56px_rgb(0_0_0/0.38)]">
        <svg viewBox="0 0 330 230" aria-hidden className="absolute inset-0 size-full">
          <path d="M0 230L165 120L330 230" fill="none" stroke="var(--color-hairline)" strokeWidth="1.5" />
          <path d="M0 0L165 130L330 0Z" fill="var(--color-tray)" stroke="var(--color-hairline)" strokeWidth="1.5" />
          <rect
            x="10"
            y="10"
            width="310"
            height="210"
            fill="none"
            stroke="var(--color-ember)"
            strokeWidth="0.75"
            strokeDasharray="2 4"
          />
        </svg>
        <button
          type="button"
          onClick={breakSeal}
          aria-label="Break the seal to open your invitation"
          className={`absolute top-[56.52%] left-1/2 aspect-square w-[29.09%] -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-0 bg-transparent p-0 drop-shadow-[0_6px_8px_rgb(61_41_39/0.35)] ${
            breaking ? "" : "animate-seal-pulse"
          }`}
        >
          <SealHalf side="left" breaking={breaking} />
          <SealHalf side="right" breaking={breaking} />
        </button>
      </div>

      <p className="mt-11 text-center font-serif text-[22px] text-linen italic">Break the seal to open</p>
    </div>
  );
}
