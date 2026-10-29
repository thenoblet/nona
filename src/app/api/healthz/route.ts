import { connection } from "next/server";

/**
 * Liveness check for Docker and Dokploy. Answered by the running server at request
 * time, and deliberately touches nothing else (no database, no storage), so a
 * hiccup in a dependency never gets a healthy app restarted.
 */
export async function GET() {
  await connection();
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
