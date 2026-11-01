import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { PhotosWishes } from "@/components/admin/photos/Photos";

export const metadata: Metadata = { title: "Wishes · Photos" };

/** The guestbook's wishes (Task 17, gate B): hide, unhide or delete each. Task 16 plays recordings here. */
export default function PhotosWishesPage() {
  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>Photos</h1>
          <p className="admin-lede">Every wish guests have left, newest first. Hidden ones stay here, so you can bring them back.</p>
        </div>
      </div>
      <Suspense fallback={<p className="admin-loading">Loading wishes…</p>}>
        <AdminGate>{() => <PhotosWishes />}</AdminGate>
      </Suspense>
    </>
  );
}
