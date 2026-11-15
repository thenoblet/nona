import { downloadReplies } from "@/lib/admin/reply-download";

/** Every current reply as a CSV file, for the couple or a viewer. */
export function GET() {
  return downloadReplies("csv");
}
