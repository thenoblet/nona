import { PgBoss, type QueueOptions } from "pg-boss";
import { dbConfig } from "@/lib/env";
import { errorMessage } from "@/lib/log-error";
import { handleRsvpConfirmation, requeueUnsentConfirmations } from "./rsvp-confirmation";

export const QUEUES = { rsvpConfirmation: "email-rsvp-confirmation" } as const;

// Next loads this file once per server bundle, so a module variable would start several queues.
// The globalThis key is shared by every bundle in the process.
const globalWithQueue = globalThis as typeof globalThis & {
  __nonaJobQueue?: Promise<PgBoss> | null;
};

/** One pg-boss per process, on its own small pool so jobs never starve the site. */
export function getBoss(): Promise<PgBoss> {
  globalWithQueue.__nonaJobQueue ??= (async () => {
    const boss = new PgBoss({
      ...dbConfig(),
      max: 3,
      connectionTimeoutMillis: 5000,
      // Sent to the server on every connection: a stalled statement is cut off after 10 s.
      options: "-c statement_timeout=10000",
    });
    // Its jobs hold only a reply id, so the queue's own errors carry no guest details.
    boss.on("error", (error) => console.error("Job queue error:", errorMessage(error)));
    try {
      await boss.start();
    } catch (error) {
      // Close whatever the failed start opened, so the next try begins from nothing.
      await boss.stop({ graceful: false }).catch(() => {});
      globalWithQueue.__nonaJobQueue = null;
      throw error;
    }
    return boss;
  })();
  return globalWithQueue.__nonaJobQueue;
}

/**
 * The confirmation job's retries. Resend's free plan sends 100 emails a day, and invitation day
 * may ask for more, so a confirmation keeps trying for a little over a day before it is marked
 * failed: the waits double from a minute up to four hours, and the 13th and last retry comes 24 to
 * 28 hours after the first try. pg-boss gives each attempt 15 minutes (expireInSeconds) and keeps
 * a job waiting to retry for 14 days (retentionSeconds), so neither cuts this short.
 */
export const CONFIRMATION_QUEUE = {
  retryLimit: 13,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 4 * 60 * 60,
} as const satisfies QueueOptions;

export async function startJobs(): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
  // createQueue leaves a queue that already exists as it was, so bring its settings up to date.
  await boss.updateQueue(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
  await boss.work<{ rsvpId: string }, void, { includeMetadata: true }>(
    QUEUES.rsvpConfirmation,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        await handleRsvpConfirmation(job.data.rsvpId, {
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
      }
    },
  );
  // Replies whose confirmation never reached the queue (the cap, a failed enqueue, or a restart
  // before after() ran) get another chance.
  await requeueUnsentConfirmations();
}
