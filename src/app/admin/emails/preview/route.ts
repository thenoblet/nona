import { connection } from "next/server";
import { AdminAccessError, requireAdmin } from "@/lib/admin/access";
import { readSiteContent } from "@/lib/content/store";
import { listRsvps } from "@/lib/data/rsvp";
import { renderFinalEmail } from "@/lib/email/final-emails";
import { finalAudience, FINAL_KINDS, newestReply, type FinalKind } from "@/lib/final-emails/audience";
import { personalLink } from "@/lib/guests/personal-link";
import { siteUrl } from "@/lib/site-url";

// Guest details must never sit in a shared cache such as Cloudflare's.
const NO_STORE = "private, no-store";

/** Who the preview is written for when nobody has replied that way yet. */
const SAMPLE_REPLY = { fullName: "Ama Owusu", answers: { ceremony: "yes", reception: "yes" } } as const;

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE } });
}

/**
 * The admin Emails page's preview: a final email as the newest guest of its kind would get it,
 * from the site text as it is now, for the couple only. One small render per look, on the couple's
 * own page; the emails themselves are rendered by the job.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) return text("This page is for the couple.", 403);
    throw error;
  }
  const kind = new URL(request.url).searchParams.get("kind");
  if (!(FINAL_KINDS as readonly (string | null)[]).includes(kind)) return text("No such email.", 404);
  const [replies, content] = await Promise.all([listRsvps(), readSiteContent()]);
  const audience = finalAudience(replies, kind as FinalKind);
  const newest = newestReply(audience);
  const link = newest?.guestId ? await personalLink(newest.guestId) : null;
  const mail = await renderFinalEmail(kind as FinalKind, newest ?? SAMPLE_REPLY, content, siteUrl(), link);
  return new Response(mail.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE } });
}
