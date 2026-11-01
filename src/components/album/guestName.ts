"use client";

import { useSyncExternalStore } from "react";

/**
 * The guest's display name, remembered on this phone so the album and the
 * guestbook can greet them. It leaves the phone only with the guest's own
 * uploads: as their guest's name, and the name shown with each one.
 */
const KEY = "nona:guest-name";
/** The guest the saved name was last taken from or typed for (Ruling CG). */
const FOR_GUEST_KEY = "nona:guest-name-for";
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or storage blocked: nothing is remembered.
  }
}

/** The saved name, or null (none saved, or storage blocked). */
export function readGuestName(): string | null {
  return read(KEY);
}

/** The browser's own guest as the server knows it. */
export type OwnGuest = { id: string; displayName: string | null };

/**
 * The name the phone shares as, given its saved name, the guest that name belongs to, and its own
 * guest as the server knows it. The saved name stays while it belongs to that guest. Otherwise
 * the phone's own guest is new to it (a personal link's "Yes, that's me" took the phone over, or it
 * just got one): it takes that guest's name, keeping its saved one only for a guest with none.
 */
export function nameForOwnGuest(
  saved: { name: string | null; forGuestId: string | null },
  ownGuest: OwnGuest,
): { name: string | null; forGuestId: string } {
  if (saved.forGuestId === ownGuest.id) return { name: saved.name, forGuestId: ownGuest.id };
  return { name: ownGuest.displayName ?? saved.name, forGuestId: ownGuest.id };
}

/**
 * Brings the saved name in line with the browser's own guest (Ruling CG): after a personal link
 * takes the phone over, "Sharing as" and the names sent with uploads are the linked guest's, until
 * the guest taps Change.
 */
export function syncGuestName(ownGuest: OwnGuest): void {
  const saved = readGuestName();
  const next = nameForOwnGuest({ name: saved, forGuestId: read(FOR_GUEST_KEY) }, ownGuest);
  write(FOR_GUEST_KEY, next.forGuestId);
  if (next.name !== saved) saveGuestName(next.name ?? "");
}

/** Records which guest the saved name belongs to, once a rename says (Change). */
export function tieGuestName(guestId: string): void {
  write(FOR_GUEST_KEY, guestId);
}

export function saveGuestName(name: string) {
  try {
    const clean = name.trim();
    if (clean) window.localStorage.setItem(KEY, clean);
    else window.localStorage.removeItem(KEY);
  } catch {
    // Private mode or storage blocked: the name just isn't remembered.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The saved name, or null (always null during server rendering). */
export function useGuestName(): string | null {
  return useSyncExternalStore(subscribe, readGuestName, () => null);
}
