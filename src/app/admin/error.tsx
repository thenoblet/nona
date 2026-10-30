"use client";

/** Shown in place of an admin page when its data can't be read, under the admin's own top bar. */
export default function AdminError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="admin-error" role="alert">
      <p>Can&apos;t reach the database right now. Try again in a minute.</p>
      <button type="button" className="admin-btn" onClick={() => retry()}>
        Try again
      </button>
    </div>
  );
}
