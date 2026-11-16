import type { IconName } from "@/components/ui/Icon";
import type { Mode } from "@/lib/mode";

/** A place in the phone's tab bar. The hero is the raised orange button in the middle. */
export type Tab = { id: string; href: string; label: string; icon: IconName; hero?: boolean };

const home: Tab = { id: "home", href: "/home", label: "Home", icon: "home" };
const programme: Tab = { id: "programme", href: "/programme", label: "Programme", icon: "clock" };
const album: Tab = { id: "album", href: "/album", label: "Album", icon: "image" };

/**
 * The tabs guests need most, which change with the wedding: before it, replying and planning the
 * trip; on the day, today's order, sharing photos and finding the way; after, reliving it.
 */
const tabs: Record<Mode, Tab[]> = {
  before: [
    home,
    programme,
    { id: "rsvp", href: "/rsvp", label: "RSVP", icon: "envelope", hero: true },
    { id: "stay", href: "/stay", label: "Stay", icon: "bed" },
    album,
  ],
  day: [
    { id: "today", href: "/today", label: "Today", icon: "sun" },
    programme,
    { id: "share", href: "/album#share", label: "Share", icon: "camera", hero: true },
    album,
    { id: "map", href: "/home#map", label: "Map", icon: "pin" },
  ],
  after: [
    home,
    { id: "relive", href: "/album", label: "Relive", icon: "image", hero: true },
    { id: "wishes", href: "/wishes", label: "Wishes", icon: "heart" },
  ],
};

export function tabsFor(mode: Mode): Tab[] {
  return tabs[mode];
}

/**
 * The tab for the page the guest is on: the one whose address is the longest start of the path.
 * A tab that jumps to a place on a page (#share, #map) is never the page itself, so it never is.
 */
export function activeTab(list: Tab[], pathname: string): string | null {
  let best: Tab | null = null;
  for (const tab of list) {
    if (tab.href.includes("#")) continue;
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (!best || tab.href.length > best.href.length)) best = tab;
  }
  return best?.id ?? null;
}
