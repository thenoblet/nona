"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { confirmLeave } from "./content/unsaved";

export type AdminTab = { href: string; label: string };

/** The couple's tabs: every part of the admin. */
export const coupleTabs: AdminTab[] = [
  { href: "/admin/rsvps", label: "Replies" },
  { href: "/admin/photos", label: "Photos" },
  { href: "/admin/content", label: "Site text" },
  { href: "/admin/photos/site", label: "Site photos" },
  { href: "/admin/people", label: "People" },
];

/** A viewer's only tab. */
export const viewerTabs: AdminTab[] = [{ href: "/admin/rsvps", label: "Replies" }];

/** The tab whose address is the longest start of the path: Site photos (/admin/photos/site) inside Photos' own. */
function currentTab(tabs: AdminTab[], currentPath: string | null): string | null {
  if (currentPath === null) return null;
  const matching = tabs.filter((tab) => currentPath === tab.href || currentPath.startsWith(`${tab.href}/`));
  return matching.sort((first, second) => second.href.length - first.href.length)[0]?.href ?? null;
}

/**
 * The tab links, marking the one for currentPath (none while the path is not known yet). A viewer
 * gets their one tab and a "View only" label, so the missing tabs read as intended, not broken.
 */
export function AdminTabLinks({ tabs, viewOnly = false, currentPath }: { tabs: AdminTab[]; viewOnly?: boolean; currentPath: string | null }) {
  const current = currentTab(tabs, currentPath);
  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {tabs.map((tab) => {
        const isCurrent = tab.href === current;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isCurrent ? "page" : undefined}
            // Leaving a section with unsaved edits asks first (see content/unsaved.ts).
            onClick={(event) => {
              if (!confirmLeave()) event.preventDefault();
            }}
          >
            {tab.label}
          </Link>
        );
      })}
      {viewOnly && <span className="admin-viewonly">View only</span>}
    </nav>
  );
}

export function AdminTabs({ tabs, viewOnly = false }: { tabs: AdminTab[]; viewOnly?: boolean }) {
  return <AdminTabLinks tabs={tabs} viewOnly={viewOnly} currentPath={usePathname()} />;
}
