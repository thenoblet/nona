"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MusicPlayer } from "./MusicPlayer";

const SLOT_ID = "dock-slot";

/**
 * Floating controls in the bottom corner: the music player, plus anything a page
 * adds with <DockItem> (the "Share a moment" button on the wedding weekend, or the
 * album's minimised uploads). Phones: full width with the page's item on the left,
 * music on the right; a row too narrow for both puts the page's item above. Clear of
 * a phone's rounded corners and home bar (the safe-area insets).
 */
export function Dock({ autoplay = false }: { autoplay?: boolean }) {
  return (
    <div className="pointer-events-none fixed right-[calc(1rem_+_env(safe-area-inset-right))] bottom-[calc(1rem_+_env(safe-area-inset-bottom))] left-[calc(1rem_+_env(safe-area-inset-left))] z-50 flex flex-wrap-reverse items-end justify-end gap-3 sm:right-[calc(1.25rem_+_env(safe-area-inset-right))] sm:bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] sm:left-[calc(1.25rem_+_env(safe-area-inset-left))]">
      <div id={SLOT_ID} className="pointer-events-auto mr-auto flex sm:mr-0 empty:hidden" />
      <div className="pointer-events-auto">
        <MusicPlayer autoplay={autoplay} />
      </div>
    </div>
  );
}

const noopSubscribe = () => () => {};

/** Renders its children into the dock, next to the music player. */
export function DockItem({ children }: { children: ReactNode }) {
  // The slot is static markup from <Dock>; read it once the page is on screen.
  const slot = useSyncExternalStore(
    noopSubscribe,
    () => document.getElementById(SLOT_ID),
    () => null,
  );
  return slot ? createPortal(children, slot) : null;
}
