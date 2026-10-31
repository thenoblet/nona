import { accraDateTime } from "@/lib/accra";
import type { ContentSection } from "@/lib/admin/content";
import { listVersions, readSection } from "@/lib/content/store";
import { ContentEditor } from "./ContentEditor";

/** One section's saved text and versions, read at request time. Render it only inside AdminGate. */
export async function SectionEditor({ section }: { section: ContentSection }) {
  const [{ value, version }, versions, { value: venues }] = await Promise.all([
    readSection(section.key),
    listVersions(section.key),
    // The celebrations show the place and GPS their venues give them.
    readSection("venues"),
  ]);
  return (
    <ContentEditor
      sectionKey={section.key}
      label={section.label}
      value={value}
      version={version}
      context={{ venues }}
      versions={versions.map((entry) => ({
        version: entry.version,
        savedAt: accraDateTime(entry.savedAt.toISOString()),
        savedBy: entry.savedBy,
      }))}
    />
  );
}
