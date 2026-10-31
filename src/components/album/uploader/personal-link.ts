"use client";

import { useSyncExternalStore } from "react";

/*
 * The guest's personal link (/my/<token>), as POST /api/guest answered it to the uploader, and
 * whether the guest has hidden its offer on this phone. Plain module state, so the offer under the
 * upload card and the slim row in My uploads share it without a provider.
 */

const HIDDEN_KEY = "nona:link-offer-hidden";

let personalLink: string | null = null;
let hidden: boolean | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Remembers the link for this page (the uploader sets it after its guest call). */
export function setPersonalLink(link: string): void {
  if (link === personalLink) return;
  personalLink = link;
  notify();
}

/** The guest's personal link, once this page knows it; null before (and on the server). */
export function usePersonalLink(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => personalLink,
    () => null,
  );
}

function readHidden(): boolean {
  if (hidden === null) {
    try {
      hidden = window.localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      hidden = false;
    }
  }
  return hidden;
}

/** Whether the guest tapped × on the offer, on this phone; true on the server, so it never flashes. */
export function useLinkOfferHidden(): boolean {
  return useSyncExternalStore(subscribe, readHidden, () => true);
}

/** Hides the offer for good on this phone (the slim row in My uploads stays). */
export function hideLinkOffer(): void {
  hidden = true;
  try {
    window.localStorage.setItem(HIDDEN_KEY, "1");
  } catch {
    // Storage blocked: it stays hidden for this page only.
  }
  notify();
}
