import { connection } from "next/server";
import { buildIcs, celebrationEvent } from "@/lib/calendar/ics";
import { getSiteContent } from "@/lib/content/get";

/** A calendar file for the celebrations named in `?events=ceremony,reception` (all three if none are valid). */
export async function GET(request: Request) {
  // Read at request time so the build never needs the database.
  await connection();
  const { celebrations } = await getSiteContent();
  const wanted = new Set((new URL(request.url).searchParams.get("events") ?? "").split(",").map((s) => s.trim()));
  const chosen = celebrations.filter((c) => wanted.has(c.id));
  const siteUrl = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const body = buildIcs((chosen.length ? chosen : celebrations).map((c) => celebrationEvent(c, siteUrl)));
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="noblet-and-nancy.ics"',
    },
  });
}
