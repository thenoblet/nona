import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { siteContent } from "@/lib/db/schema";
import { contentDefaults } from "./defaults";
import { formatIssues, sectionSchemas, type RsvpSettings } from "./schema";

/** Who closed replies and when: the saved version that closed them. */
export type RsvpClosure = { savedAt: Date; savedBy: string };

/**
 * The RSVP settings as the admin sees them, read at request time: the newest saved version (the
 * built-in settings are version 0) and, while replies are closed, the version that closed them.
 * A later save that kept them closed, such as a new message, doesn't move the close.
 */
export async function readRsvpSettings(): Promise<{ value: RsvpSettings; version: number; closed: RsvpClosure | null }> {
  const versions = await getDb()
    .select({ version: siteContent.version, value: siteContent.value, savedAt: siteContent.savedAt, savedBy: siteContent.savedBy })
    .from(siteContent)
    .where(eq(siteContent.key, "rsvp"))
    .orderBy(desc(siteContent.version));

  const settings = versions.map((entry) => sectionSchemas.rsvp.safeParse(entry.value));
  const [newest] = settings;
  if (newest && !newest.success) {
    console.error('Saved site content for "rsvp" is invalid; using the built-in text.', formatIssues(newest.error, "rsvp"));
  }
  const value = newest?.success ? newest.data : contentDefaults.rsvp;

  let closed: RsvpClosure | null = null;
  for (const [index, parsed] of settings.entries()) {
    if (!parsed.success || parsed.data.open) break;
    closed = { savedAt: versions[index].savedAt, savedBy: versions[index].savedBy };
  }
  return { value, version: versions[0]?.version ?? 0, closed };
}
