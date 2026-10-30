import { connection } from "next/server";
import { getSetting } from "@/lib/data/settings";
import { isHeartbeatFresh } from "@/lib/jobs/worker-heartbeat";
import { describeError } from "@/lib/log-error";

/**
 * Whether the media worker is alive, for the uptime check: 200 while its heartbeat (saved every
 * 30 s) is under 2 minutes old, 503 otherwise, and 503 when the database can't be read. Nothing
 * else in the answer. One primary-key read; at request time, so the build needs no database.
 */
export async function GET() {
  await connection();
  let alive = false;
  try {
    alive = isHeartbeatFresh(await getSetting("worker_heartbeat", null));
  } catch (error) {
    console.error("[worker-health] could not read the heartbeat:", describeError(error));
  }
  return new Response(null, { status: alive ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
