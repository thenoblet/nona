import { downloadReplies } from "@/lib/admin/reply-download";

/** Every current reply as an Excel workbook, for the couple only. */
export function GET() {
  return downloadReplies("xlsx");
}
