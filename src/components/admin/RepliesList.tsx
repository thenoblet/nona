"use client";

import { useMemo, useState } from "react";
import {
  countByFilter,
  emailStatusLabels,
  matchesFilter,
  matchesSearch,
  replyFilters,
  type CelebrationColumn,
  type ReplyFilter,
  type ReplyRow,
} from "@/lib/admin/replies";

function changedLabel(times: number): string {
  if (times === 1) return "Changed once";
  if (times === 2) return "Changed twice";
  return `Changed ${times} times`;
}

const badgeTone = { sent: "ok", queued: "wait", failed: "bad", none: "none" } as const;

/** Search and filters run here over the list the gated page passed down (a few hundred replies at most). */
export function RepliesList({ replies, celebrations }: { replies: ReplyRow[]; celebrations: CelebrationColumn[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReplyFilter>("all");
  const counts = useMemo(() => countByFilter(replies), [replies]);
  const shown = useMemo(
    () => replies.filter((row) => matchesFilter(row, filter) && matchesSearch(row, query)),
    [replies, filter, query],
  );

  return (
    <>
      <div className="admin-toolbar">
        <label className="admin-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Name, phone or email"
            aria-label="Search replies"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="admin-filters" role="group" aria-label="Show">
          {replyFilters.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.attention ? "admin-filter admin-filter-attention" : "admin-filter"}
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label} <b className="admin-num">{counts[option.id]}</b>
            </button>
          ))}
        </div>
      </div>
      <p className="admin-sr-only" role="status">
        {shown.length === replies.length ? "" : `Showing ${shown.length} of ${replies.length} replies`}
      </p>

      {replies.length === 0 ? (
        <p className="admin-empty">No replies yet. They appear here as guests send them.</p>
      ) : shown.length === 0 ? (
        <p className="admin-empty">No replies match.</p>
      ) : (
        <div className="admin-tablewrap">
          <table className="admin-replies">
            <thead>
              <tr>
                <th scope="col">Guest</th>
                <th scope="col">Party</th>
                {celebrations.map((celebration) => (
                  <th scope="col" key={celebration.id} className="admin-answer-heading">
                    {celebration.name}
                  </th>
                ))}
                <th scope="col">Email</th>
                <th scope="col">Replied</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td className="admin-guest">
                    <div className="admin-guest-name">{row.fullName}</div>
                    <div className="admin-guest-contact admin-num">
                      {row.phone} · {row.email ?? "no email"}
                    </div>
                    {row.otherNames && <div className="admin-guest-contact">With {row.otherNames}</div>}
                    {row.song && <div className="admin-guest-contact">Song: {row.song}</div>}
                    {row.duplicates.map((note) => (
                      <span className="admin-flag" key={note}>
                        {note}
                      </span>
                    ))}
                    {row.earlier.length > 0 && (
                      <details className="admin-history">
                        <summary>{changedLabel(row.earlier.length)}</summary>
                        {row.earlier.map((earlier) => (
                          <div className="admin-earlier" key={earlier.id}>
                            <b>{earlier.received}</b> · {earlier.details.join(" · ")}
                          </div>
                        ))}
                      </details>
                    )}
                  </td>
                  <td className="admin-party" data-label="Party">
                    {row.partySize}
                  </td>
                  {celebrations.map((celebration) => {
                    const answer = row.answers[celebration.id];
                    return (
                      <td
                        key={celebration.id}
                        className={answer === "yes" ? "admin-answer admin-yes" : "admin-answer admin-no"}
                        data-label={celebration.name}
                      >
                        {answer === "yes" ? "Yes" : answer === "no" ? "No" : (
                          <>
                            <span aria-hidden="true">—</span>
                            <span className="admin-sr-only">No answer</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                  <td data-label="Email">
                    <span className={`admin-badge admin-badge-${badgeTone[row.emailStatus]}`}>
                      {emailStatusLabels[row.emailStatus]}
                    </span>
                  </td>
                  <td className="admin-replied admin-num" data-label="Replied">
                    <time dateTime={row.receivedAt}>{row.received}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
