import { accraDateTime } from "@/lib/admin/replies";
import type { ContentSection } from "@/lib/admin/content";
import { listVersions, readSection } from "@/lib/content/store";
import { ContentEditor } from "./ContentEditor";

/** One section's saved text and versions, read at request time. Render it only inside AdminGate. */
export async function SectionEditor({ section }: { section: ContentSection }) {
  const [{ value, version }, versions] = await Promise.all([readSection(section.key), listVersions(section.key)]);
  return (
    <ContentEditor
      sectionKey={section.key}
      label={section.label}
      value={value}
      version={version}
      versions={versions.map((entry) => ({
        version: entry.version,
        savedAt: accraDateTime(entry.savedAt.toISOString()),
        savedBy: entry.savedBy,
      }))}
    />
  );
}
