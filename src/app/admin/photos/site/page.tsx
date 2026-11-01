import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { SitePhotos } from "@/components/admin/site/SitePhotos";

export const metadata: Metadata = { title: "Site photos" };

/** The site's own photos (Task 19, gate B): each slot's photo, alt text and focal point, and the link preview cards. */
export default function SitePhotosPage() {
  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>Site photos</h1>
          <p className="admin-lede">Your own photos around the site. Until you replace one, the site uses its built-in photo.</p>
        </div>
      </div>
      <Suspense fallback={<p className="admin-loading">Loading photos…</p>}>
        <AdminGate>{() => <SitePhotos />}</AdminGate>
      </Suspense>
    </>
  );
}
