import Link from "next/link";
import { Halo } from "@/components/ui/Halo";

/**
 * The floating "Share a moment" button for the wedding weekend, on laptops; on phones the tab bar's
 * middle Share button does its job. Render it inside <DockItem> so it sits beside the music player.
 */
export function SharePill() {
  return (
    <Link
      href="/album"
      className="press hidden min-h-14 animate-nudge items-center gap-3 rounded-full bg-ember py-2 pr-6 pl-2 text-xs font-medium uppercase tracking-[0.18em] text-cocoa no-underline shadow-[0_1px_2px_rgb(61_41_39/0.2),0_10px_26px_rgb(61_41_39/0.2),inset_0_1px_0_rgb(255_255_255/0.3)] lg:flex"
    >
      <Halo icon="camera" tone="glass" size="md" />
      Share a moment
    </Link>
  );
}
