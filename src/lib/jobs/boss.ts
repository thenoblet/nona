import { PgBoss } from "pg-boss";
import { dbConfig } from "@/lib/env";
import { handleRsvpConfirmation } from "./rsvp-confirmation";

export const QUEUES = { rsvpConfirmation: "email-rsvp-confirmation" } as const;

let started: Promise<PgBoss> | null = null;

/** One pg-boss per process, on its own small pool so jobs never starve the site. */
export function getBoss(): Promise<PgBoss> {
  started ??= (async () => {
    const boss = new PgBoss({
      ...dbConfig(),
      max: 3,
      connectionTimeoutMillis: 5000,
    });
    boss.on("error", (error) => console.error("Job queue error", error));
    try {
      await boss.start();
    } catch (error) {
      started = null;
      throw error;
    }
    return boss;
  })();
  return started;
}

export async function startJobs(): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(QUEUES.rsvpConfirmation, {
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
  });
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
}
