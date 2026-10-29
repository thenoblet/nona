import Link from "next/link";
import type { ReactNode } from "react";
import { couple } from "@/content/wedding";
import { Icon } from "@/components/ui/Icon";

/**
 * The top bar on single-task pages (RSVP, album, wishes): back arrow, monogram,
 * optional action on the right. Content sits in a phone-width column that stays
 * centred on larger screens.
 */
export function PhoneHeader({
  backHref = "/home",
  backLabel = "Back to the website",
  right,
  tone = "dark",
  children,
  className = "",
}: {
  backHref?: string;
  backLabel?: string;
  right?: ReactNode;
  tone?: "dark" | "light";
  children?: ReactNode;
  className?: string;
}) {
  const dark = tone === "dark";
  return (
    <header className={`${dark ? "bg-cocoa text-white" : "bg-blush text-cocoa"} ${className}`}>
      <div className="mx-auto w-full max-w-xl px-5 pt-5 pb-8 sm:px-8">
        <div className="flex items-center justify-between">
          <Link
            href={backHref}
            aria-label={backLabel}
            className="-ml-3 flex size-11 items-center justify-center rounded-full"
          >
            <Icon name="back" size={22} strokeWidth={1.6} />
          </Link>
          <Link href="/home" className="font-script text-3xl text-ember no-underline" aria-label="Home">
            {couple.monogram}
          </Link>
          <div className="flex min-w-8 justify-end">{right}</div>
        </div>
        {children}
      </div>
    </header>
  );
}
