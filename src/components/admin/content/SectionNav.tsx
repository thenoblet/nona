"use client";

import Link from "next/link";
import { contentSections } from "@/lib/admin/content";
import { confirmLeave } from "./unsaved";

/** The list of sections beside the editor, from 760 px up. Leaving unsaved edits asks first. */
export function SectionNav({ current }: { current: string }) {
  return (
    <nav className="admin-sectionnav" aria-label="Sections">
      {contentSections.map((section) => {
        const isCurrent = section.slug === current;
        return (
          <Link
            key={section.slug}
            href={`/admin/content/${section.slug}`}
            aria-current={isCurrent ? "page" : undefined}
            onClick={(event) => {
              if (!isCurrent && !confirmLeave()) event.preventDefault();
            }}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
