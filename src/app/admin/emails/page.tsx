import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { FinalEmails } from "@/components/admin/emails/FinalEmails";

export const metadata: Metadata = { title: "Emails" };

/** The last emails to everyone who replied, sent once replies close. */
export default function EmailsPage() {
  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>Emails</h1>
          <p className="admin-lede">
            Once replies close, thank everyone who replied: the details for the day to guests coming, a thank-you to those who can&apos;t.
            The email they got when they replied doesn&apos;t change.
          </p>
        </div>
      </div>
      <Suspense fallback={<p className="admin-loading">Loading emails…</p>}>
        <AdminGate>{() => <FinalEmails />}</AdminGate>
      </Suspense>
    </>
  );
}
