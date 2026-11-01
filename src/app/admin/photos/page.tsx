import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { PhotosAlbum } from "@/components/admin/photos/Photos";

export const metadata: Metadata = { title: "Photos" };

/** Everything guests have shared (Task 17, gate B): the switches, then the album to moderate. */
export default function PhotosPage({ searchParams }: PageProps<"/admin/photos">) {
  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>Photos</h1>
          <p className="admin-lede">Everything guests have shared, newest first. Hidden ones stay here, so you can bring them back.</p>
        </div>
      </div>
      <Suspense fallback={<p className="admin-loading">Loading photos…</p>}>
        <AdminGate>{() => <PhotosAlbum searchParams={searchParams} />}</AdminGate>
      </Suspense>
    </>
  );
}
