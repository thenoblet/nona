import { desc, eq, and, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { siteContent } from "@/lib/db/schema";
import { contentDefaults } from "./defaults";
import { formatIssues, sectionKeys, sectionSchemas, type SectionKey, type SiteContent } from "./schema";

export type SaveResult = { ok: true; version: number } | { ok: false; errors: string[] };

/** The latest saved version of each key, merged over the built-in defaults. */
export async function readSiteContent(): Promise<SiteContent> {
  const rows = await getDb()
    .selectDistinctOn([siteContent.key], { key: siteContent.key, value: siteContent.value })
    .from(siteContent)
    .orderBy(siteContent.key, desc(siteContent.version));

  const merged: SiteContent = { ...contentDefaults };
  for (const row of rows) {
    if (!(sectionKeys as string[]).includes(row.key)) continue;
    const key = row.key as SectionKey;
    const parsed = sectionSchemas[key].safeParse(row.value);
    if (parsed.success) {
      (merged as Record<SectionKey, unknown>)[key] = parsed.data;
    } else {
      console.error(`Saved site content for "${key}" is invalid; using the built-in text.`, formatIssues(parsed.error, key));
    }
  }
  return merged;
}

/** Runs `read`, and falls back to the built-in text if it throws. */
export async function contentOrDefaults(read: () => Promise<SiteContent>): Promise<SiteContent> {
  try {
    return await read();
  } catch (error) {
    console.error("Could not read site content; using the built-in text.", error);
    return contentDefaults;
  }
}

export async function saveSection(key: SectionKey, value: unknown, savedBy: string): Promise<SaveResult> {
  const parsed = sectionSchemas[key].safeParse(value);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error, key) };

  const version = await getDb().transaction(async (tx) => {
    // Serialise saves of the same key so two editors cannot pick the same version number.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [latest] = await tx
      .select({ version: siteContent.version })
      .from(siteContent)
      .where(eq(siteContent.key, key))
      .orderBy(desc(siteContent.version))
      .limit(1);
    const next = (latest?.version ?? 0) + 1;
    await tx.insert(siteContent).values({ key, version: next, value: parsed.data, savedBy });
    return next;
  });
  return { ok: true, version };
}

export async function listVersions(key: SectionKey): Promise<{ version: number; savedAt: Date; savedBy: string }[]> {
  return getDb()
    .select({ version: siteContent.version, savedAt: siteContent.savedAt, savedBy: siteContent.savedBy })
    .from(siteContent)
    .where(eq(siteContent.key, key))
    .orderBy(desc(siteContent.version));
}

/** Saves a copy of an earlier version as a new version. */
export async function restoreVersion(key: SectionKey, version: number, savedBy: string): Promise<SaveResult> {
  const [row] = await getDb()
    .select({ value: siteContent.value })
    .from(siteContent)
    .where(and(eq(siteContent.key, key), eq(siteContent.version, version)));
  if (!row) return { ok: false, errors: [`Version ${version} of ${key} does not exist`] };
  return saveSection(key, row.value, savedBy);
}
