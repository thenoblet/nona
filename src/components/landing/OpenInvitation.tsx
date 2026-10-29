"use client";

import Link from "next/link";
import { useMusic } from "@/components/music/MusicProvider";

/**
 * "Open the invitation": the tap starts the music (browsers need a tap before
 * sound plays) and the song carries on into the homepage.
 */
export function OpenInvitation() {
  const music = useMusic();
  return (
    <Link
      href="/home"
      onClick={() => music.play()}
      className="press inline-flex min-h-14 items-center justify-center rounded-full bg-cocoa px-8 text-xs uppercase tracking-[0.2em] text-white no-underline shadow-[var(--shadow-pill-cocoa)]"
    >
      Open the invitation
    </Link>
  );
}
