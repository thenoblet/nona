"use client";

import { useEffect } from "react";
import { currentGuest } from "./album-client";
import { syncGuestName } from "./guestName";
import { setPersonalLink } from "./uploader/personal-link";

/** How long the page must stay in view before it asks: a camera capture hides and shows it again. */
const ASK_AFTER_MILLISECONDS = 1_000;

/**
 * When the page comes back into view, asks again which guest this phone is (Ruling CG): a tab left
 * open while a personal link's "Yes, that's me" took the phone over, in another tab, then offers
 * the linked guest's link (the "Copy link" row and the first upload's offer) and shares as their
 * name, not the earlier guest's. Its uploads already go with the link: each upload reads the guest
 * from the cookie. Only for a phone that has a guest (`hasGuest`), since asking makes one for a
 * phone that hasn't. It waits a second in view, so quick hide-and-shows (a photo taken with the
 * phone's camera) ask once, and a newer ask ends the one before it.
 */
export function useFreshGuestOnReturn(hasGuest: boolean): void {
  useEffect(() => {
    if (!hasGuest) return;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    let asking: AbortController | null = null;

    async function ask() {
      asking?.abort();
      const thisAsk = new AbortController();
      asking = thisAsk;
      const guest = await currentGuest(thisAsk.signal);
      if (!guest || thisAsk.signal.aborted) return;
      setPersonalLink(guest.link);
      syncGuestName({ id: guest.guestId, displayName: guest.displayName });
    }

    function onVisibilityChange() {
      clearTimeout(waiting);
      if (document.visibilityState === "visible") waiting = setTimeout(ask, ASK_AFTER_MILLISECONDS);
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(waiting);
      asking?.abort();
    };
  }, [hasGuest]);
}
