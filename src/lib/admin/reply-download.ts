import { connection } from "next/server";
import { AdminAccessError, requireViewerOrCouple } from "@/lib/admin/access";
import { toCsv } from "@/lib/admin/csv";
import { replyColumns, replyCsvRows } from "@/lib/admin/replies";
import { toXlsx } from "@/lib/admin/xlsx";
import { accraDate } from "@/lib/accra";
import { getSiteContent } from "@/lib/content/get";
import { listRsvps } from "@/lib/data/rsvp";

// Guest details must never sit in a shared cache such as Cloudflare's.
const NO_STORE = "private, no-store";

const formats = {
  csv: { type: "text/csv; charset=utf-8", build: (rows: string[][]) => toCsv(rows) },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", build: (rows: string[][]) => toXlsx(rows, "Replies") },
} as const;

/**
 * Every current reply as a file to download, for the couple or a viewer: CSV for any tool, or an Excel
 * workbook that opens with its header bold and frozen and phone numbers kept as typed.
 */
export async function downloadReplies(format: keyof typeof formats): Promise<Response> {
  // Request time only: a build without the Access settings must never prerender the refusal.
  await connection();
  try {
    await requireViewerOrCouple();
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
  const rows = replyCsvRows(replies, replyColumns(celebrations));
  const { type, build } = formats[format];
  return new Response(build(rows), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="nona-rsvps-${accraDate(new Date())}.${format}"`,
      "Cache-Control": NO_STORE,
    },
  });
}
