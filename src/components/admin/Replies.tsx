import { wedding } from "@/content/wedding";
import { celebrationDay, toReplyRows } from "@/lib/admin/replies";
import { getSiteContent } from "@/lib/content/get";
import { listRsvps, rsvpHistories, rsvpTotals } from "@/lib/data/rsvp";
import { RepliesList } from "./RepliesList";

function count(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}

/** The replies page's data: totals per celebration, then every current reply. Render it only inside AdminGate. */
export async function Replies() {
  const [replies, histories, totals, { celebrations }] = await Promise.all([
    listRsvps(),
    rsvpHistories(),
    rsvpTotals(),
    getSiteContent(),
  ]);
  const columns = celebrations.map(({ id, name }) => ({ id, name }));
  const rows = toReplyRows(replies, histories, columns, new Date());

  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>Replies</h1>
          <p className="admin-lede">Newest first. Replies are due {wedding.rsvpBy}.</p>
        </div>
        {/* A plain link: the file downloads, and an expired sign-in still reaches the login page. */}
        <a className="admin-btn" href="/admin/rsvps.csv">
          Download CSV
        </a>
      </div>

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
      </section>
      <p className="admin-footnote">Guest counts add up party sizes, counting “4 or more” as 4.</p>

      <RepliesList replies={rows} celebrations={columns} />
    </>
  );
}
