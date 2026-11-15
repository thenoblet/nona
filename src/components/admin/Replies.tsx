import { accraDateTime, accraDayAndFullMonth } from "@/lib/accra";
import { RETIRED_EVENT_LABEL, celebrationDay, countByFilter, replyColumns, toReplyRows } from "@/lib/admin/replies";
import { getSiteContent } from "@/lib/content/get";
import { readRsvpSettings } from "@/lib/content/rsvp";
import { listRsvps, rsvpHistories, rsvpTotals } from "@/lib/data/rsvp";
import { RepliesList } from "./RepliesList";
import { RsvpSettings } from "./RsvpSettings";

function count(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}

/**
 * The replies page's data: the RSVP settings, totals per celebration, then every current reply.
 * Render it only inside AdminGate.
 */
export async function Replies() {
  const [replies, histories, totals, { celebrations, rsvp }, settings] = await Promise.all([
    listRsvps(),
    rsvpHistories(),
    rsvpTotals(),
    getSiteContent(),
    readRsvpSettings(),
  ]);
  const columns = replyColumns(celebrations);
  const rows = toReplyRows(replies, histories, columns, new Date());
  // The follow-up list's count, as its filter gives it, so the card and the filter always agree.
  const saidYesToThanksgiving = countByFilter(rows).thanksgiving;

  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>Replies</h1>
          <p className="admin-lede">
            Newest first. {rsvp.open ? `Replies are due ${accraDayAndFullMonth(rsvp.replyBy)}.` : "RSVPs are closed."}
          </p>
        </div>
        {/* Plain links: the file downloads, and an expired sign-in still reaches the login page. */}
        <div className="admin-downloads">
          <a className="admin-btn" href="/admin/rsvps.xlsx">
            Download Excel
          </a>
          <a className="admin-btn" href="/admin/rsvps.csv">
            Download CSV
          </a>
        </div>
      </div>

      <RsvpSettings
        open={settings.value.open}
        replyBy={settings.value.replyBy}
        replyByLabel={accraDayAndFullMonth(settings.value.replyBy)}
        closedMessage={settings.value.closedMessage}
        version={settings.version}
        closedSince={settings.closed ? `${accraDateTime(settings.closed.savedAt.toISOString())} by ${settings.closed.savedBy}` : null}
      />

      <section className="admin-stats" aria-label="Totals">
        {celebrations.map((celebration) => {
          const total = totals[celebration.id];
          return (
            <article className="admin-stat" key={celebration.id}>
              <h2>{celebration.name}</h2>
              <p className="admin-stat-when">{celebrationDay(celebration.date)}</p>
              <p className="admin-stat-big admin-num">
                {total.people} <span>{total.people === 1 ? "guest" : "guests"}</span>
              </p>
              <p className="admin-stat-split admin-num">
                <span>{count(total.accepted, "reply", "replies")} coming</span>
                <span>{total.declined} can&apos;t come</span>
              </p>
            </article>
          );
        })}
        {/* Guests are no longer asked to it: the card counts the replies to follow up, current or earlier. */}
        <article className="admin-stat">
          <h2>{RETIRED_EVENT_LABEL}</h2>
          <p className="admin-stat-big admin-num">
            {count(saidYesToThanksgiving, "reply", "replies")} <span>said yes</span>
          </p>
        </article>
      </section>
      <p className="admin-footnote">Guest counts add up party sizes, counting “4 or more” as 4.</p>

      <RepliesList replies={rows} celebrations={columns} />
    </>
  );
}
