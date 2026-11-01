import "server-only";
import { findGuestById } from "@/lib/data/guests";
import type { Guest } from "@/lib/data/types";
import { siteUrl } from "@/lib/site-url";

// Apart from the cookie's code, so the confirmation job, which puts the link in its email, never
// loads request-only modules such as next/headers.

/** The personal link of a guest in hand, which brings their uploads to any phone. */
export function personalLinkOf(guest: Pick<Guest, "linkToken">): string {
  return `${siteUrl()}/my/${guest.linkToken}`;
}

/** The guest's personal link, which brings their uploads to any phone; null for no such guest. */
export async function personalLink(guestId: string): Promise<string | null> {
  const guest = await findGuestById(guestId);
  return guest ? personalLinkOf(guest) : null;
}
