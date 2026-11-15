import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { RoleTabs } from "@/components/admin/RoleTabs";
import { LeaveLink } from "@/components/admin/LeaveLink";
import "./admin.css";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

// Only the static shell lives here. Data is rendered inside <AdminGate> on each page.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="admin">
      <header className="admin-topbar">
        <div className="admin-topbar-inner">
          <LeaveLink href="/admin/rsvps" className="admin-brand">
            Noblet &amp; Nancy <span>· admin</span>
          </LeaveLink>
          {/* The tabs depend on who is signed in, so none show until that is known: a viewer never
              sees the couple's tabs flash up. */}
          <Suspense fallback={<nav className="admin-tabs" aria-label="Admin sections" />}>
            <RoleTabs />
          </Suspense>
          <LeaveLink href="/" className="admin-viewsite">
            View site ↗
          </LeaveLink>
        </div>
      </header>
      <main className="admin-page">{children}</main>
    </div>
  );
}
