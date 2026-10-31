"use client";

import { useSyncExternalStore } from "react";

/*
 * The guest's personal link (/my/<token>), as POST /api/guest answered it to the uploader, and
 * whether its offer may show on this phone: gate A shows it once, under the first completed
 * upload, and × hides it for good. Plain module state, so the offer under the upload card and the
 * slim row in My uploads share it without a provider.
 */

const HIDDEN_KEY = "nona:link-offer-hidden";
const SHOWN_KEY = "nona:link-offer-shown";

let personalLink: string | null = null;
let hidden: boolean | null = null;
/** Whether an earlier page showed the offer: read once, before this page shows it. */
let shownBefore: boolean | null = null;
let shownOnThisPage = false;
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

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the offer may show: not hidden, and not shown on an earlier page (gate A: once). On the
 * page that shows it, it stays until hidden. False on the server, so it never flashes.
 */
function offerAllowed(): boolean {
  if (readHidden()) return false;
  shownBefore ??= readFlag(SHOWN_KEY);
  return shownOnThisPage || !shownBefore;
}

export function useLinkOfferAllowed(): boolean {
  return useSyncExternalStore(subscribe, offerAllowed, () => false);
}

/** The offer is on screen: remembered, so later pages don't offer it again. */
export function markLinkOfferShown(): void {
  if (shownOnThisPage) return;
  shownBefore ??= readFlag(SHOWN_KEY);
  shownOnThisPage = true;
  try {
    window.localStorage.setItem(SHOWN_KEY, "1");
  } catch {
    // Storage blocked: it may be offered again on a later page.
  }
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
