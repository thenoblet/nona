import type { ReactNode } from "react";

/**
 * Markup only classic Outlook for Windows reads, in a conditional comment. React can't write a
 * comment by itself, so it goes in a span that `unwrapOutlookOnly` takes away after rendering:
 * a table opened in one OutlookOnly and closed in another must not end up inside two spans.
 */
export function OutlookOnly({ html }: { html: string }) {
  return <span data-outlook-only="true" dangerouslySetInnerHTML={{ __html: `<!--[if mso]>${html}<![endif]-->` }} />;
}

const WRAPPED_COMMENT = /<span data-outlook-only="true"><!--\[if mso\]>([\s\S]*?)<!\[endif\]--><\/span>/g;

/** Leaves each OutlookOnly as its bare conditional comment. */
export function unwrapOutlookOnly(html: string): string {
  return html.replace(WRAPPED_COMMENT, "<!--[if mso]>$1<![endif]-->");
}

/**
 * Classic Outlook for Windows ignores max-width, so there a table of fixed width (the usual "ghost
 * table") holds what it wraps; every other client never sees it.
 */
export function OutlookFixedWidth({ width, children }: { width: number; children: ReactNode }) {
  return (
    <>
      <OutlookOnly
        html={`<table role="presentation" align="center" width="${width}" cellpadding="0" cellspacing="0" border="0"><tr><td>`}
      />
      {children}
      <OutlookOnly html="</td></tr></table>" />
    </>
  );
}
