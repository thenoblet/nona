"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { confirmLeave } from "./content/unsaved";

const tabs = [
  { href: "/admin/rsvps", label: "Replies" },
  { href: "/admin/content", label: "Site text" },
];

/** The tab links, marking the one for currentPath (none while the path is not known yet). */
export function AdminTabLinks({ currentPath }: { currentPath: string | null }) {
  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {tabs.map((tab) => {
        const isCurrent =
          currentPath !== null && (currentPath === tab.href || currentPath.startsWith(`${tab.href}/`));
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
      <span className="admin-tab-disabled" aria-disabled="true">
        Photos <small>soon</small>
      </span>
    </nav>
  );
}

export function AdminTabs() {
  return <AdminTabLinks currentPath={usePathname()} />;
}
