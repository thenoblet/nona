import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AdminAccessError, identifyAdmin, type AdminIdentity } from "@/lib/admin/access";

/**
 * Every admin page renders its data only inside <Suspense><AdminGate>…</AdminGate></Suspense>.
 * The layout holds just the static shell: a layout check would not stop the page's data being sent.
 *
 * A page is the couple's unless it says `allow="viewer"` (only Replies does). A viewer who opens
 * one of the couple's pages is sent to the Replies list; anyone the admin doesn't know is refused.
 */
export async function AdminGate({
  allow = "couple",
  children,
}: {
  allow?: "couple" | "viewer";
  children: (admin: AdminIdentity) => ReactNode;
}) {
  await connection();
  let admin: AdminIdentity;
  try {
    admin = await identifyAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return <p className="admin-denied">This page is for the couple.</p>;
    }
    throw error;
  }
  if (admin.role === "viewer" && allow === "couple") redirect("/admin/rsvps");
  return children(admin);
}
