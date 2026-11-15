import { accraDateTime } from "@/lib/accra";
import { coupleEmails } from "@/lib/admin/access";
import { listViewers } from "@/lib/data/admin-viewers";
import { PeopleManager } from "./PeopleManager";

/**
 * Who can open the admin: the couple (from the server's settings) and the viewers the couple added
 * here, then those removed earlier. Render it only inside AdminGate (the couple's).
 */
export async function People() {
  const { current, removed } = await listViewers();
  const couple = coupleEmails();
  return (
    <>
      <section className="admin-people-card admin-people-steps" aria-labelledby="people-how">
        <h2 id="people-how">Giving someone view-only access</h2>
        <ol>
          <li>In Cloudflare, add their email to the admin&apos;s Access list, so they can sign in at all.</li>
          <li>Add the same email below. They can then read the Replies list and download it, and change nothing.</li>
        </ol>
        <p className="admin-field-hint">Removing them here is enough to stop them. Remove them in Cloudflare too to stop them signing in at all.</p>
      </section>

      <PeopleManager
        viewers={current.map((viewer) => ({ id: viewer.id, email: viewer.email, added: `${accraDateTime(viewer.addedAt)} by ${viewer.addedBy}` }))}
      />

      {removed.length > 0 && (
        <details className="admin-people-card admin-people-removed">
          <summary>Removed earlier ({removed.length})</summary>
          <ul className="admin-people-list">
            {removed.map((viewer) => (
              <li key={viewer.id}>
                <span className="admin-people-email">{viewer.email}</span>
                <span className="admin-field-hint">
                  Added {accraDateTime(viewer.addedAt)} by {viewer.addedBy}. Removed {accraDateTime(viewer.removedAt ?? viewer.addedAt)} by{" "}
                  {viewer.removedBy}.
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section className="admin-people-card" aria-labelledby="people-couple">
        <h2 id="people-couple">The couple</h2>
        {couple ? (
          <>
            <p className="admin-field-hint">Everything in the admin. Set on the server, in ADMIN_COUPLE_EMAILS, so it can&apos;t be changed here.</p>
            <ul className="admin-people-list">
              {couple.map((email) => (
                <li key={email}>
                  <span className="admin-people-email">{email}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="admin-notice admin-notice-bad" role="note">
            Set ADMIN_COUPLE_EMAILS on the server to your two sign-in emails. Until then, anyone Cloudflare Access lets in who isn&apos;t a
            viewer gets everything.
          </p>
        )}
      </section>
    </>
  );
}
