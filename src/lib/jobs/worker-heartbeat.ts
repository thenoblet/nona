/*
 * The media worker's heartbeat: it saves the time in settings.worker_heartbeat every 30 s, and the
 * web app's /api/worker-health reads it for the uptime check. Pure: the worker and the app share it.
 */

/** How often the worker saves its heartbeat. */
export const WORKER_HEARTBEAT_MILLISECONDS = 30_000;

/** A heartbeat this old, or older (four missed in a row), means the worker is down. */
export const WORKER_HEARTBEAT_STALE_MILLISECONDS = 2 * 60_000;

/**
 * Whether the worker's last heartbeat is under 2 minutes old. A heartbeat that isn't a time, or
 * one as far ahead as that (a wrong clock), counts as stale too.
 */
export function isHeartbeatFresh(heartbeat: unknown, now: Date = new Date()): boolean {
  if (typeof heartbeat !== "string") return false;
  const beatAt = Date.parse(heartbeat);
  if (Number.isNaN(beatAt)) return false;
  return Math.abs(now.getTime() - beatAt) < WORKER_HEARTBEAT_STALE_MILLISECONDS;
}
