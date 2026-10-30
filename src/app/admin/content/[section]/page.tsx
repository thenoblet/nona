import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminGate } from "@/components/admin/AdminGate";
import { SectionEditor } from "@/components/admin/content/SectionEditor";
import { SectionNav } from "@/components/admin/content/SectionNav";
import { SectionPicker } from "@/components/admin/content/SectionPicker";
import { contentSections, sectionBySlug } from "@/lib/admin/content";

// Every section is known at build time, so each page's shell (heading and section list) is
// prerendered; its text and versions stream in from inside the gate.
export function generateStaticParams() {
  return contentSections.map((section) => ({ section: section.slug }));
}

// Moving to another section waits for its page rather than showing a loading state in place of
// the heading and section list: the heading depends on the address, and the text needs the
// database either way.
export const instant = false;

export async function generateMetadata({ params }: PageProps<"/admin/content/[section]">): Promise<Metadata> {
  const section = sectionBySlug((await params).section);
  return { title: section ? `${section.label} · Site text` : "Site text" };
}

export default async function ContentSectionPage({ params }: PageProps<"/admin/content/[section]">) {
  const section = sectionBySlug((await params).section);
  if (!section) notFound();

  return (
    <>
      <div className="admin-pagehead">
        <div>
          <h1>{section.label}</h1>
          <p className="admin-lede">Changes appear on the site as soon as you save.</p>
        </div>
      </div>
      <SectionPicker key={section.slug} current={section.slug} />
      <div className="admin-editor">
        <SectionNav current={section.slug} />
        <Suspense fallback={<p className="admin-loading admin-editor-main">Loading {section.label.toLowerCase()}…</p>}>
          <AdminGate>{() => <SectionEditor section={section} />}</AdminGate>
        </Suspense>
      </div>
    </>
  );
}
