"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { confirmLeave } from "./content/unsaved";

const tabs = [
  { href: "/admin/rsvps", label: "Replies" },
  { href: "/admin/photos", label: "Photos" },
  { href: "/admin/content", label: "Site text" },
  { href: "/admin/photos/site", label: "Site photos" },
];

/** The tab whose address is the longest start of the path: Site photos (/admin/photos/site) inside Photos' own. */
function currentTab(currentPath: string | null): string | null {
  if (currentPath === null) return null;
  const matching = tabs.filter((tab) => currentPath === tab.href || currentPath.startsWith(`${tab.href}/`));
  return matching.sort((first, second) => second.href.length - first.href.length)[0]?.href ?? null;
}

/** The tab links, marking the one for currentPath (none while the path is not known yet). */
export function AdminTabLinks({ currentPath }: { currentPath: string | null }) {
  const current = currentTab(currentPath);
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
    </nav>
  );
}

export function AdminTabs() {
  return <AdminTabLinks currentPath={usePathname()} />;
}
