"use client";

import { useEffect } from "react";
import { currentGuest } from "./album-client";
import { syncGuestName } from "./guestName";
import { setPersonalLink } from "./uploader/personal-link";

/**
 * When the page comes back into view, asks again which guest this phone is (Ruling CG): a tab left
 * open while a personal link's "Yes, that's me" took the phone over, in another tab, then offers
 * the linked guest's link (the "Copy link" row and the first upload's offer) and shares as their
 * name, not the earlier guest's. Its uploads already go with the link: each upload reads the guest
 * from the cookie. Only for a phone that has a guest (`hasGuest`), since asking makes one for a
 * phone that hasn't; one call each time the page is shown again, under the guest's own limit.
 */
export function useFreshGuestOnReturn(hasGuest: boolean): void {
  useEffect(() => {
    if (!hasGuest) return;
    let latest = 0;
    async function askAgain() {
      if (document.visibilityState !== "visible") return;
      const asked = ++latest;
      const guest = await currentGuest();
      // Only the newest answer counts, if the page was shown twice quickly.
      if (!guest || asked !== latest) return;
      setPersonalLink(guest.link);
      syncGuestName({ id: guest.guestId, displayName: guest.displayName });
    }
    document.addEventListener("visibilitychange", askAgain);
    return () => document.removeEventListener("visibilitychange", askAgain);
  }, [hasGuest]);
}
