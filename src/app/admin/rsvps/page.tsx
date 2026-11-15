import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { Replies } from "@/components/admin/Replies";

export const metadata: Metadata = { title: "Replies" };

export default function RepliesPage() {
  return (
    <Suspense fallback={<p className="admin-loading">Loading replies…</p>}>
      {/* The one page a viewer may open: read-only for them, with the downloads. */}
      <AdminGate allow="viewer">{(admin) => <Replies readOnly={admin.role === "viewer"} />}</AdminGate>
    </Suspense>
  );
}
