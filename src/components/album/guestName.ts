"use client";

import { useSyncExternalStore } from "react";

/**
 * The guest's display name, remembered on this phone so the album and the
 * guestbook can greet them. It leaves the phone only with the guest's own
 * uploads: as their guest's name, and the name shown with each one.
 */
const KEY = "nona:guest-name";
const listeners = new Set<() => void>();

/** The saved name, or null (none saved, or storage blocked). */
export function readGuestName(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
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
