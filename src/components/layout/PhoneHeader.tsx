import Link from "next/link";
import type { ReactNode } from "react";
import { couple } from "@/content/wedding";
import { Icon } from "@/components/ui/Icon";

/**
 * The top bar on single-task pages (RSVP, album, wishes): a labelled way out, monogram,
 * optional action on the right. Content sits in a phone-width column that stays
 * centred on larger screens.
 *
 * Most guests land here from a QR code, with nothing to go back to, so the way out is a
 * pill that says where it goes ("Home", "Album") rather than a bare back arrow.
 */
export function PhoneHeader({
  backHref = "/home",
  backText = "Home",
  right,
  tone = "dark",
  children,
  className = "",
}: {
  backHref?: string;
  /** The pill's visible text and accessible name: where it goes, in a word. */
  backText?: string;
  right?: ReactNode;
  tone?: "dark" | "light";
  children?: ReactNode;
  className?: string;
}) {
  const dark = tone === "dark";
  const pill = dark
    ? "border-white/35 bg-white/10 text-white hover:bg-white/20"
    : "border-cocoa/20 bg-white text-cocoa shadow-[var(--shadow-pill-white)] hover:border-cocoa/40";
  return (
    <header className={`${dark ? "bg-cocoa text-white" : "bg-blush text-cocoa"} ${className}`}>
      <div className="mx-auto w-full max-w-xl px-5 pt-5 pb-8 sm:px-8">
        {/* Equal side columns keep the monogram centred whatever sits either side of it. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <Link
            href={backHref}
            className={`press -ml-1 flex min-h-11 items-center gap-1.5 justify-self-start rounded-full border py-2 pr-4 pl-2.5 text-[11px] uppercase tracking-[0.18em] no-underline transition-[background-color,border-color] duration-200 ${pill}`}
          >
            <Icon name="back" size={16} strokeWidth={1.8} />
            {backText}
          </Link>
          <Link href="/home" className="font-script text-3xl text-ember no-underline" aria-label="Wedding website home">
            {couple.monogram}
          </Link>
          <div className="flex justify-end">{right}</div>
        </div>
        {children}
      </div>
    </header>
  );
}
