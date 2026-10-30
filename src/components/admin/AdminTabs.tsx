"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/admin/rsvps", label: "Replies" },
  { href: "/admin/content", label: "Site text" },
];

/** The tab links, marking the one for currentPath (none while the path is not known yet). */
export function AdminTabLinks({ currentPath }: { currentPath: string | null }) {
  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={
            currentPath !== null && (currentPath === tab.href || currentPath.startsWith(`${tab.href}/`))
              ? "page"
              : undefined
          }
        >
          {tab.label}
        </Link>
      ))}
      <span className="admin-tab-disabled" aria-disabled="true">
        Photos <small>soon</small>
      </span>
    </nav>
  );
}

export function AdminTabs() {
  return <AdminTabLinks currentPath={usePathname()} />;
}
