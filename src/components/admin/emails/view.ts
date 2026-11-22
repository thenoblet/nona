import type { FinalKind } from "@/lib/final-emails/audience";

/** A guest without an email, with the message ready to send them on WhatsApp. */
export type WhatsappGuest = { phoneKey: string; name: string; phone: string; party: string; href: string; ticked: boolean };

/** One kind of final email as the admin's Emails page shows it. */
export type KindView = {
  kind: FinalKind;
  title: string;
  lede: string;
  /** Guests of this kind with an email: one per address. */
  withEmail: number;
  /** Of those, the ones who haven't had it yet: what Send sends to. */
  notYet: number;
  /** Replies sharing an address with a newer one, which get no email of their own. */
  merged: number;
  sent: number;
  waiting: number;
  failed: number;
  failures: { email: string; error: string }[];
  lastTest: { to: string; status: "queued" | "sent" | "failed"; error: string | null; at: string } | null;
  whatsapp: WhatsappGuest[];
};

/** One press of Send, for "Sent before". */
export type BatchView = { id: string; title: string; count: number; sent: number; failed: number; when: string; by: string };
