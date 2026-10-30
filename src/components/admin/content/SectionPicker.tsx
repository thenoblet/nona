"use client";

import { useRouter } from "next/navigation";
import { contentSections } from "@/lib/admin/content";

/** Below 760 px the section list becomes this menu. */
export function SectionPicker({ current }: { current: string }) {
  const router = useRouter();
  return (
    <div className="admin-sectionpick">
      <label htmlFor="admin-section-pick">Section</label>
      <select
        id="admin-section-pick"
        defaultValue={current}
        onChange={(event) => router.push(`/admin/content/${event.target.value}`)}
      >
        {contentSections.map((section) => (
          <option key={section.slug} value={section.slug}>
            {section.label}
          </option>
        ))}
      </select>
    </div>
  );
}
