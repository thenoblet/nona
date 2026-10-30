"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/admin/rsvps", label: "Replies" },
  { href: "/admin/content", label: "Site text" },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={pathname === tab.href || pathname.startsWith(`${tab.href}/`) ? "page" : undefined}
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
