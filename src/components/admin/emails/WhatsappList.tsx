"use client";

import { useId, useOptimistic, useTransition } from "react";
import { markWhatsappAction } from "@/app/admin/emails/actions";
import type { FinalKind } from "@/lib/final-emails/audience";
import type { WhatsappGuest } from "./view";

/**
 * Guests who gave no email: a button opens WhatsApp with the same message written for each, and
 * the couple tick them off once sent. The tick is saved, so both of them see it.
 */
export function WhatsappList({ kind, title, guests }: { kind: FinalKind; title: string; guests: WhatsappGuest[] }) {
  const headingId = useId();
  const [, startTransition] = useTransition();
  const [ticks, setTick] = useOptimistic(
    new Map(guests.map((guest) => [guest.phoneKey, guest.ticked])),
    (current: Map<string, boolean>, change: { phoneKey: string; ticked: boolean }) => new Map(current).set(change.phoneKey, change.ticked),
  );

  const toggle = (guest: WhatsappGuest, ticked: boolean) =>
    startTransition(async () => {
      setTick({ phoneKey: guest.phoneKey, ticked });
      await markWhatsappAction(kind, guest.phoneKey, ticked).catch(() => undefined);
    });

  const done = [...ticks.values()].filter(Boolean).length;

  return (
    <section className="admin-people-card admin-emails-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p className="admin-field-hint">
        Send them the same message on WhatsApp: the button opens a chat with it written for you. Tick each one once it&apos;s sent ({done}{" "}
        of {guests.length} so far).
      </p>
      <ul className="admin-people-list">
        {guests.map((guest) => (
          <li key={guest.phoneKey} className="admin-emails-guest">
            <span className="admin-emails-who">
              <span className="admin-people-email">{guest.name}</span>
              <span className="admin-field-hint">
                {guest.phone} · {guest.party}
              </span>
            </span>
            <a className="admin-flag-btn admin-emails-wa" href={guest.href} target="_blank" rel="noopener noreferrer">
              WhatsApp {kind === "details" ? "the details" : "the thank-you"}
              <span className="admin-sr-only"> to {guest.name} (opens WhatsApp)</span>
            </a>
            <label className="admin-emails-tick">
              <input type="checkbox" checked={ticks.get(guest.phoneKey) ?? false} onChange={(event) => toggle(guest, event.target.checked)} />
              Sent<span className="admin-sr-only"> to {guest.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
