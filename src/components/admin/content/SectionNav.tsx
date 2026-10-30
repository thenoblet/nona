import Link from "next/link";
import { contentSections } from "@/lib/admin/content";

/** The list of sections beside the editor, from 760 px up. */
export function SectionNav({ current }: { current: string }) {
  return (
    <nav className="admin-sectionnav" aria-label="Sections">
      {contentSections.map((section) => (
        <Link
          key={section.slug}
          href={`/admin/content/${section.slug}`}
          aria-current={section.slug === current ? "page" : undefined}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
