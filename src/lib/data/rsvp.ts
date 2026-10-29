import "server-only";
import type { RsvpInput, RsvpRecord } from "./types";

/**
 * STUB. Replies are kept in memory and lost on restart.
 * Swap these functions for Postgres queries; callers don't change.
 */
const replies = new Map<string, RsvpRecord>();

export async function saveRsvp(input: RsvpInput): Promise<RsvpRecord> {
  // "Send a new reply with the same name" replaces the earlier one.
  const key = input.fullName.trim().toLowerCase();
  const record: RsvpRecord = {
    ...input,
    id: key,
    receivedAt: new Date().toISOString(),
  };
  replies.set(key, record);
  console.info("[stub] RSVP saved", { name: record.fullName, answers: record.answers });
  return record;
}

export async function findRsvpByName(fullName: string): Promise<RsvpRecord | null> {
  return replies.get(fullName.trim().toLowerCase()) ?? null;
}
