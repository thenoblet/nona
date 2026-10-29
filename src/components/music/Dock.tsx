"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MusicPlayer } from "./MusicPlayer";

const SLOT_ID = "dock-slot";

/**
 * Floating controls in the bottom corner: the music player, plus anything a page
 * adds with <DockItem> (the "Share a moment" button on the wedding weekend).
 * Phones: full width with the page's item on the left, music on the right.
 */
export function Dock({ autoplay = false }: { autoplay?: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-wrap-reverse items-end justify-end gap-3 sm:inset-x-5 sm:bottom-5">
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
