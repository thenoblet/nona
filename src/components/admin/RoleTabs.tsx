import { Suspense } from "react";
import { connection } from "next/server";
import { AdminAccessError, identifyAdmin } from "@/lib/admin/access";
import { AdminTabLinks, AdminTabs, coupleTabs, viewerTabs } from "./AdminTabs";

/**
 * The top bar's tabs for whoever is signed in: all of them for the couple, Replies and "View only"
 * for a viewer, none for anyone the admin doesn't know. The pages check again; this only decides
 * what the bar offers.
 */
export async function RoleTabs() {
  await connection();
  let role: "couple" | "viewer";
  try {
    role = (await identifyAdmin()).role;
  } catch (error) {
    if (error instanceof AdminAccessError) return <nav className="admin-tabs" aria-label="Admin sections" />;
    throw error;
  }
  const tabs = role === "viewer" ? viewerTabs : coupleTabs;
  const viewOnly = role === "viewer";
  return (
    // usePathname can suspend during a prerender, so the tabs keep their links either way.
    <Suspense fallback={<AdminTabLinks tabs={tabs} viewOnly={viewOnly} currentPath={null} />}>
      <AdminTabs tabs={tabs} viewOnly={viewOnly} />
    </Suspense>
  );
}
