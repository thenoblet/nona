"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { contentSections } from "@/lib/admin/content";
import { confirmLeave } from "./unsaved";

/**
 * Below 760 px the section list becomes this menu. Choosing a section doesn't leave the page by
 * itself (arrow keys on a closed menu change it one step at a time); "Go" does.
 */
export function SectionPicker({ current }: { current: string }) {
  const router = useRouter();
  const go = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const slug = new FormData(event.currentTarget).get("section");
    if (typeof slug !== "string" || slug === current || !confirmLeave()) return;
    router.push(`/admin/content/${slug}`);
  };
  return (
    <form className="admin-sectionpick" onSubmit={go}>
      <label htmlFor="admin-section-pick">Section</label>
      <div className="admin-sectionpick-row">
        <select id="admin-section-pick" name="section" defaultValue={current}>
          {contentSections.map((section) => (
            <option key={section.slug} value={section.slug}>
              {section.label}
            </option>
          ))}
        </select>
        <button type="submit" className="admin-btn">
          Go
        </button>
      </div>
    </form>
  );
}
