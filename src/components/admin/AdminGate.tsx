import type { ReactNode } from "react";
import { connection } from "next/server";
import { AdminAccessError, requireAdmin } from "@/lib/admin/access";

/**
 * Every admin page renders its data only inside <Suspense><AdminGate>…</AdminGate></Suspense>.
 * The layout holds just the static shell: a layout check would not stop the page's data being sent.
 */
export async function AdminGate({ children }: { children: (admin: { email: string }) => ReactNode }) {
  await connection();
  let admin: { email: string };
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return <p className="admin-denied">This page is for the couple.</p>;
    }
    throw error;
  }
  return children(admin);
}
