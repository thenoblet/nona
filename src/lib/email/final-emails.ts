import { createElement } from "react";
import { render, toPlainText } from "react-email";
import { unwrapOutlookOnly } from "@/emails/components/OutlookOnly";
import FinalDetails from "@/emails/final-details";
import FinalThanks from "@/emails/final-thanks";
import type { SiteContent } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";
import type { FinalKind } from "@/lib/final-emails/audience";
import { finalHelpers, finalStays, finalTravel, weddingDay } from "@/lib/final-emails/content";
import { plainName } from "@/lib/rsvp/normalize";
import { emailCelebrations } from "./celebrations";

export const FINAL_SUBJECTS: Record<FinalKind, string> = {
  details: "Everything you need for our wedding day",
  thanks: "Thank you, from Noblet & Nancy",
};

/**
 * A final email for a reply, rendered from the templates in `src/emails`: "details" for a guest
 * coming, "thanks" for one who isn't. The site text is read when the job runs, so it says what the
 * site says. Only the final-email job and the admin's preview route import this, so the renderer
 * stays out of the pages' bundles.
 */
export async function renderFinalEmail(
  kind: FinalKind,
  rsvp: Pick<RsvpRecord, "fullName" | "answers">,
  content: SiteContent,
  siteUrl: string,
  personalLink: string | null = null,
): Promise<{ subject: string; text: string; html: string }> {
  // Only a plain name is echoed back: the address is unverified, so a link must not ride along.
  const guestName = plainName(rsvp.fullName);
  const element =
    kind === "details"
      ? createElement(FinalDetails, {
          guestName,
          celebrations: emailCelebrations(rsvp, content, siteUrl).filter((celebration) => celebration.attending),
          siteUrl,
          personalLink,
          helpers: finalHelpers(content),
          travel: finalTravel(content, siteUrl),
          stays: finalStays(content),
        })
      : createElement(FinalThanks, { guestName, siteUrl, day: weddingDay(content) });
  const html = unwrapOutlookOnly(await render(element));
  const text = toPlainText(html, {
    selectors: [
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
      { selector: "a[data-text-without-href=true]", format: "anchor", options: { ignoreHref: true } },
    ],
  });
  return { subject: FINAL_SUBJECTS[kind], text, html };
}
