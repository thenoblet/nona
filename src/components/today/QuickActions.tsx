import Link from "next/link";
import type { Venue } from "@/lib/content/schema";
import { Halo } from "@/components/ui/Halo";
import type { IconName } from "@/components/ui/Icon";

/** `note` tells screen readers where an outside link goes. */
type Tile = { href: string; label: string; icon: IconName; primary?: boolean; external?: { note: string } };

function tilesFor(reception: Venue, liveUrl: string | null): Tile[] {
  return [
    { href: "/album", label: "Share photos", icon: "camera", primary: true },
    ...(liveUrl
      ? [{ href: liveUrl, label: "Watch live", icon: "video" as const, external: { note: "(opens the live stream)" } }]
      : []),
    { href: reception.mapsUrl, label: "Directions", icon: "pin", external: { note: "(opens Google Maps)" } },
    { href: "/wishes", label: "Leave a wish", icon: "heart" },
  ];
}

const tileClass =
  "flex min-h-28 flex-col gap-3 rounded-[var(--radius-paper)] bg-white px-4 py-4.5 text-cocoa no-underline shadow-[0_1px_2px_rgb(61_41_39/0.06),0_10px_24px_rgb(61_41_39/0.08)] transition-[translate,box-shadow] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] hover:-translate-y-[3px] hover:shadow-[0_2px_4px_rgb(61_41_39/0.06),0_18px_36px_rgb(61_41_39/0.14)] active:translate-y-px";

function TileBody({ tile }: { tile: Tile }) {
  return (
    <>
      <Halo icon={tile.icon} tone={tile.primary ? "ember" : "halo"} size="md" />
      <span className="font-serif text-[21px] leading-[1.1] italic">{tile.label}</span>
    </>
  );
}

/**
 * The 2 x 2 grid of things guests reach for on the day. `liveUrl` is set only once the live
 * stream is showing; without it the last tile spans both columns so the grid stays even.
 */
export function QuickActions({ reception, liveUrl }: { reception: Venue; liveUrl: string | null }) {
  const tiles = tilesFor(reception, liveUrl);
  return (
    <ul className="grid grid-cols-2 gap-3">
      {tiles.map((tile, index) => {
        // An odd tile out at the end takes the whole row, so the grid stays even.
        const spansRow = tiles.length % 2 === 1 && index === tiles.length - 1;
        return (
          <li key={tile.label} className={`flex ${spansRow ? "col-span-2" : ""}`}>
            {tile.external ? (
              <a href={tile.href} target="_blank" rel="noopener noreferrer" className={`${tileClass} w-full`}>
                <TileBody tile={tile} />
                <span className="sr-only">{tile.external.note}</span>
              </a>
            ) : (
              <Link href={tile.href} className={`${tileClass} w-full`}>
                <TileBody tile={tile} />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
