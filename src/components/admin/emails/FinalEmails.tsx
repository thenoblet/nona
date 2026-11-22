import { accraDateTime } from "@/lib/accra";
import { readSiteContent } from "@/lib/content/store";
import { whatsappHref } from "@/lib/content/phone";
import { listFinalEmails, whatsappMarks, type FinalEmail } from "@/lib/data/final-emails";
import { listRsvps } from "@/lib/data/rsvp";
import { finalAudience, FINAL_KINDS, type FinalKind } from "@/lib/final-emails/audience";
import { whatsappMessage } from "@/lib/final-emails/whatsapp";
import { personalLink } from "@/lib/guests/personal-link";
import { siteUrl } from "@/lib/site-url";
import { FinalEmailCard } from "./FinalEmailCard";
import { WhatsappList } from "./WhatsappList";
import type { BatchView, KindView } from "./view";

const words: Record<FinalKind, { title: string; lede: string; stat: string }> = {
  details: {
    title: "Final details",
    lede: "For guests coming: thanks by name, their celebrations, who to call on the day, getting to Tepa, where to stay and their personal link.",
    stat: "Coming, with an email",
  },
  thanks: {
    title: "Thank-you",
    lede: "For guests who can't come: thanks by name, and the day through the guests' eyes in the live album, and a wish.",
    stat: "Not coming, with an email",
  },
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The admin's Emails page: once replies close, the couple send everyone who replied a last email,
 * by kind. Render it only inside AdminGate (the couple's).
 */
export async function FinalEmails() {
  const [replies, emails, marks, content] = await Promise.all([listRsvps(), listFinalEmails(), whatsappMarks(), readSiteContent()]);
  const site = siteUrl();

  const views: KindView[] = await Promise.all(
    FINAL_KINDS.map(async (kind) => {
      const audience = finalAudience(replies, kind);
      const ofKind = emails.filter((email) => email.kind === kind && !email.test);
      const had = new Set(ofKind.map((email) => email.emailKey));
      const test = emails.find((email) => email.kind === kind && email.test) ?? null;
      const whatsapp = await Promise.all(
        audience.byWhatsapp.map(async ({ reply, phoneKey }) => {
          const link = kind === "details" && reply.guestId ? await personalLink(reply.guestId) : null;
          return {
            phoneKey,
            name: reply.fullName,
            phone: reply.phone,
            party: reply.partySize,
            href: whatsappHref(reply.phone, whatsappMessage(kind, reply, content, site, link)),
            ticked: marks.has(`${kind}:${phoneKey}`),
          };
        }),
      );
      return {
        kind,
        title: words[kind].title,
        lede: words[kind].lede,
        withEmail: audience.byEmail.length,
        notYet: audience.byEmail.filter((recipient) => !had.has(recipient.emailKey)).length,
        merged: audience.merged,
        sent: ofKind.filter((email) => email.status === "sent").length,
        waiting: ofKind.filter((email) => email.status === "queued").length,
        failed: ofKind.filter((email) => email.status === "failed").length,
        failures: ofKind.filter((email) => email.status === "failed").map((email) => ({ email: email.email, error: email.error ?? "" })),
        lastTest: test ? { to: test.email, status: test.status, error: test.error, at: accraDateTime(test.queuedAt) } : null,
        whatsapp,
      };
    }),
  );

  const batches = new Map<string, FinalEmail[]>();
  for (const email of emails) {
    if (email.test) continue;
    batches.set(email.batchId, [...(batches.get(email.batchId) ?? []), email]);
  }
  const history: BatchView[] = [...batches.entries()].map(([id, batch]) => ({
    id,
    title: words[batch[0].kind].title,
    count: batch.length,
    sent: batch.filter((email) => email.status === "sent").length,
    failed: batch.filter((email) => email.status === "failed").length,
    when: accraDateTime(batch[0].queuedAt),
    by: batch[0].queuedBy,
  }));

  return (
    <>
      <div className="admin-stats admin-emails-stats">
        {views.map((view) => (
          <section key={view.kind} className="admin-stat">
            <h2>{words[view.kind].stat}</h2>
            <p className="admin-stat-big">{view.withEmail}</p>
            <p className="admin-stat-split">
              {view.withEmail > 0 && view.notYet === 0
                ? "All have had it"
                : view.notYet === view.withEmail
                  ? `Get the ${view.title.toLowerCase()} email`
                  : `${view.notYet} haven't had it yet`}
              {view.whatsapp.length > 0 ? ` · ${view.whatsapp.length} with no email` : ""}
            </p>
          </section>
        ))}
        <section className="admin-stat">
          <h2>Replies</h2>
          <p className="admin-stat-big">{content.rsvp.open ? "Open" : "Closed"}</p>
          <p className="admin-stat-split">{content.rsvp.open ? "Close them on Replies when you're ready" : "Ready to send"}</p>
        </section>
      </div>

      {content.rsvp.open ? (
        <p className="admin-notice admin-emails-notice" role="note">
          Replies are still open. You can send now: anyone who replies later gets the email when you press Send again, which sends
          only to those who haven&apos;t had it.
        </p>
      ) : null}

      {views.map((view) => (
        <FinalEmailCard key={view.kind} view={view} />
      ))}

      {views.map((view) =>
        view.whatsapp.length > 0 ? (
          <WhatsappList key={view.kind} kind={view.kind} title={`${view.kind === "details" ? "Coming" : "Not coming"}, with no email (${view.whatsapp.length})`} guests={view.whatsapp} />
        ) : null,
      )}

      {history.length > 0 ? (
        <section className="admin-people-card admin-emails-card" aria-labelledby="emails-history">
          <h2 id="emails-history">Sent before</h2>
          <ul className="admin-people-list">
            {history.map((batch) => (
              <li key={batch.id}>
                <span className="admin-people-email">
                  {batch.title} · {plural(batch.count, "guest")}
                </span>
                <span className="admin-field-hint">
                  {batch.when} by {batch.by} · {batch.sent} sent{batch.failed > 0 ? `, ${batch.failed} failed` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
