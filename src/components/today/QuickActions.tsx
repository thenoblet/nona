import Link from "next/link";
import { venues } from "@/content/wedding";
import { Halo } from "@/components/ui/Halo";
import type { IconName } from "@/components/ui/Icon";

type Tile = { href: string; label: string; icon: IconName; primary?: boolean; external?: boolean };

const tiles: Tile[] = [
  { href: "/album", label: "Share photos", icon: "camera", primary: true },
  { href: "#live", label: "Watch live", icon: "video" },
  { href: venues.reception.mapsUrl, label: "Directions", icon: "pin", external: true },
  { href: "/wishes", label: "Leave a wish", icon: "heart" },
];

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

/** The 2 x 2 grid of things guests reach for on the day. */
export function QuickActions() {
  return (
    <ul className="grid grid-cols-2 gap-3">
      {tiles.map((t) => (
        <li key={t.label} className="flex">
          {t.external ? (
            <a href={t.href} target="_blank" rel="noopener noreferrer" className={`${tileClass} w-full`}>
              <TileBody tile={t} />
              <span className="sr-only">(opens Google Maps)</span>
            </a>
          ) : (
            <Link href={t.href} className={`${tileClass} w-full`}>
              <TileBody tile={t} />
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
