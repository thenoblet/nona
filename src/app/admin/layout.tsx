import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminTabs, AdminTabLinks } from "@/components/admin/AdminTabs";
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
          <Link href="/admin" className="admin-brand">
            Noblet &amp; Nancy <span>· admin</span>
          </Link>
          {/* usePathname can suspend during a prerender, so the tabs keep their links either way. */}
          <Suspense fallback={<AdminTabLinks currentPath={null} />}>
            <AdminTabs />
          </Suspense>
          <Link href="/" className="admin-viewsite">
            View site ↗
          </Link>
        </div>
      </header>
      <main className="admin-page">{children}</main>
    </div>
  );
}
