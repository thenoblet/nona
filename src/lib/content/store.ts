import { desc, eq, and, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { siteContent } from "@/lib/db/schema";
import { describeError } from "@/lib/log-error";
import { contentDefaults } from "./defaults";
import { formatIssues, sectionKeys, sectionSchemas, type SectionKey, type SiteContent } from "./schema";

/** Who saved the newest version, when a save was made from an older one. */
export type NewerVersion = { version: number; savedAt: Date; savedBy: string };

export type SaveResult = { ok: true; version: number } | { ok: false; errors: string[]; newer?: NewerVersion };

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
    console.error("Could not read site content; using the built-in text:", describeError(error));
    return contentDefaults;
  }
}

/** The newest saved value of one section and its version; the built-in text is version 0. */
export async function readSection<TKey extends SectionKey>(
  key: TKey,
): Promise<{ value: SiteContent[TKey]; version: number }> {
  const [row] = await getDb()
    .select({ value: siteContent.value, version: siteContent.version })
    .from(siteContent)
    .where(eq(siteContent.key, key))
    .orderBy(desc(siteContent.version))
    .limit(1);
  if (!row) return { value: contentDefaults[key], version: 0 };
  const parsed = sectionSchemas[key].safeParse(row.value);
  if (!parsed.success) {
    console.error(`Saved site content for "${key}" is invalid; using the built-in text.`, formatIssues(parsed.error, key));
    return { value: contentDefaults[key], version: row.version };
  }
  return { value: parsed.data as SiteContent[TKey], version: row.version };
}

/**
 * Validates and saves a section as its next version. With `baseVersion` (the version an editor
 * loaded), the save is refused if anyone saved since: the check runs under the same lock as the
 * insert, so of two editors saving from one version only the first gets through.
 */
export async function saveSection(
  key: SectionKey,
  value: unknown,
  savedBy: string,
  options: { baseVersion?: number } = {},
): Promise<SaveResult> {
  const parsed = sectionSchemas[key].safeParse(value);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error, key) };

  return getDb().transaction(async (tx): Promise<SaveResult> => {
    // Serialise saves of the same key so two editors cannot pick the same version number.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [latest] = await tx
      .select({ version: siteContent.version, savedAt: siteContent.savedAt, savedBy: siteContent.savedBy })
      .from(siteContent)
      .where(eq(siteContent.key, key))
      .orderBy(desc(siteContent.version))
      .limit(1);
    const latestVersion = latest?.version ?? 0;
    if (latest && options.baseVersion !== undefined && latestVersion > options.baseVersion) {
      const errors = [`Version ${latestVersion} of ${key} was saved after version ${options.baseVersion}`];
      return { ok: false, errors, newer: latest };
    }
    const next = latestVersion + 1;
    await tx.insert(siteContent).values({ key, version: next, value: parsed.data, savedBy });
    return { ok: true, version: next };
  });
}

export async function listVersions(key: SectionKey): Promise<{ version: number; savedAt: Date; savedBy: string }[]> {
  return getDb()
    .select({ version: siteContent.version, savedAt: siteContent.savedAt, savedBy: siteContent.savedBy })
    .from(siteContent)
    .where(eq(siteContent.key, key))
    .orderBy(desc(siteContent.version));
}

/**
 * Saves a copy of an earlier version as a new version. With `baseVersion`, it is refused like any
 * other save if someone saved after the page that asked for it was loaded.
 */
export async function restoreVersion(
  key: SectionKey,
  version: number,
  savedBy: string,
  options: { baseVersion?: number } = {},
): Promise<SaveResult> {
  const [row] = await getDb()
    .select({ value: siteContent.value })
    .from(siteContent)
    .where(and(eq(siteContent.key, key), eq(siteContent.version, version)));
  if (!row) return { ok: false, errors: [`Version ${version} of ${key} does not exist`] };
  return saveSection(key, row.value, savedBy, options);
}
