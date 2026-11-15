import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { People } from "@/components/admin/people/People";

export const metadata: Metadata = { title: "People" };

/** Who can open the admin: the couple, and the viewers the couple let read the Replies list. */
export default function PeoplePage() {
  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>People with access</h1>
          <p className="admin-lede">Let someone read the Replies list and download it, without changing anything.</p>
        </div>
      </div>
      <Suspense fallback={<p className="admin-loading">Loading people…</p>}>
        <AdminGate>{() => <People />}</AdminGate>
      </Suspense>
    </>
  );
}
