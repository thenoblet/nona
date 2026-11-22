"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { retryFailedAction, sendFinalEmailsAction, sendTestAction, type SendResult } from "@/app/admin/emails/actions";
import type { KindView } from "./view";

const NOT_DONE = "That didn't go through. Check the connection, reload the page and try again.";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * One kind of final email: what it says (a preview), a test to the couple, and Send with an inline
 * confirm, as Delete has on Replies. While emails are on their way the page asks again every 2 s,
 * so the progress moves and the failures show up.
 */
export function FinalEmailCard({ view }: { view: KindView }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingId = useId();
  const questionId = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);

  const inFlight = view.waiting > 0 || view.lastTest?.status === "queued";
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  const run = (action: () => Promise<SendResult>) => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await action();
        setMessage(result.ok ? result.message : result.error);
      } catch {
        setMessage(NOT_DONE);
      }
      setConfirming(false);
    });
  };

  const total = view.sent + view.waiting + view.failed;
  const guests = plural(view.notYet, "guest");

  return (
    <section className="admin-people-card admin-emails-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{view.title} email</h2>
      <p className="admin-field-hint">{view.lede} It says what the site says when you send it, so check the Site text first.</p>

      <div className="admin-emails-grid">
        <div className="admin-emails-controls">
          <p className="admin-emails-count">
            {view.withEmail === 0
              ? "Nobody to send it to yet."
              : view.notYet === 0
                ? `All ${plural(view.withEmail, "guest")} with an email have had it.`
                : `${view.notYet} of ${plural(view.withEmail, "guest")} with an email haven't had it yet.`}
            {view.merged > 0 ? ` ${plural(view.merged, "reply")} share an address with another and get one email between them.` : ""}
          </p>

          <div className="admin-flag-actions">
            <button type="button" className="admin-flag-btn" disabled={pending} onClick={() => run(() => sendTestAction(view.kind))}>
              Send a test to me
            </button>
            {confirming ? null : (
              <button
                type="button"
                className={`admin-flag-btn ${view.notYet === 0 ? "" : "admin-flag-btn-primary"}`}
                disabled={pending || view.notYet === 0}
                onClick={() => setConfirming(true)}
              >
                {view.notYet === 0 ? "Everyone has had it" : `Send to ${guests}`}
              </button>
            )}
          </div>
          {view.lastTest ? (
            <p className="admin-field-hint">
              Last test: {view.lastTest.at} to {view.lastTest.to},{" "}
              {view.lastTest.status === "sent" ? "sent" : view.lastTest.status === "queued" ? "on its way" : `failed: ${view.lastTest.error}`}.
            </p>
          ) : null}

          {confirming ? (
            <div className="admin-confirm" role="group" aria-labelledby={questionId}>
              <p id={questionId}>Send the {view.title.toLowerCase()} email to {guests} now?</p>
              <p>Each gets one email, by name. You can&apos;t take it back. Anyone who replies later can get it when you press Send again.</p>
              <div className="admin-flag-actions">
                <button
                  type="button"
                  className="admin-flag-btn admin-flag-btn-primary"
                  disabled={pending}
                  onClick={() => run(() => sendFinalEmailsAction(view.kind))}
                >
                  {pending ? "Sending…" : `Yes, send to ${guests}`}
                </button>
                <button ref={cancelButton} type="button" className="admin-flag-btn" disabled={pending} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <p className="admin-field-hint" role="status">
            {message}
          </p>

          {total > 0 ? (
            <div className="admin-progress admin-emails-progress">
              <span>
                {view.waiting > 0 ? `Sending: ${view.sent} of ${total} sent. It carries on if you close this page.` : `${view.sent} of ${total} sent.`}
                {view.failed > 0 ? ` ${view.failed} failed.` : ""}
              </span>
              <span className="admin-progress-track" aria-hidden>
                <span className="admin-progress-fill" style={{ width: `${Math.round((view.sent / total) * 100)}%` }} />
              </span>
            </div>
          ) : null}

          {view.failures.length > 0 ? (
            <div className="admin-emails-failures">
              <p className="admin-label">Didn&apos;t go out</p>
              <ul className="admin-people-list">
                {view.failures.map((failure) => (
                  <li key={failure.email}>
                    <span className="admin-people-email">{failure.email}</span>
                    <span className="admin-field-hint">{failure.error}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="admin-flag-btn" disabled={pending} onClick={() => run(() => retryFailedAction(view.kind))}>
                Try the {plural(view.failures.length, "email")} again
              </button>
            </div>
          ) : null}
        </div>

        <div className="admin-emails-preview">
          <p className="admin-label">Preview, as the newest guest would get it</p>
          <iframe title={`Preview of the ${view.title.toLowerCase()} email`} src={`/admin/emails/preview?kind=${view.kind}`} loading="lazy" />
        </div>
      </div>
    </section>
  );
}
