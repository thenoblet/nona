import { connection } from "next/server";
import { AdminAccessError, requireAdmin } from "@/lib/admin/access";
import { toCsv } from "@/lib/admin/csv";
import { accraDate } from "@/lib/accra";
import { replyCsvRows } from "@/lib/admin/replies";
import { getSiteContent } from "@/lib/content/get";
import { listRsvps } from "@/lib/data/rsvp";

// Guest details must never sit in a shared cache such as Cloudflare's.
const NO_STORE = "private, no-store";

/** Every current reply as a spreadsheet, for the couple only. */
export async function GET() {
  // Request time only: a build without the Access settings must never prerender the refusal.
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return new Response("This page is for the couple.", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE },
      });
    }
    throw error;
  }

  const [replies, { celebrations }] = await Promise.all([listRsvps(), getSiteContent()]);
  return new Response(toCsv(replyCsvRows(replies, celebrations)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="nona-rsvps-${accraDate(new Date())}.csv"`,
      "Cache-Control": NO_STORE,
    },
  });
}
