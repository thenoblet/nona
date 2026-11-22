import { queuedFinalEmailIds } from "@/lib/data/final-emails";
import { describeError } from "@/lib/log-error";
import { getBoss, QUEUES } from "./boss";

// Queueing only: the admin's actions import this, so nothing here may load the email renderer.

/** Sends a job for each final email; ids only, so the queue holds no guest details. */
export async function queueFinalEmailJobs(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const boss = await getBoss();
  await boss.insert(
    QUEUES.finalEmail,
    ids.map((id) => ({ data: { id } })),
  );
}

/**
 * When the job queue starts: send a job for every final email still waiting, in case one was
 * written but its job never reached the queue. The job skips an email already sent. Never throws.
 */
export async function requeueWaitingFinalEmails(): Promise<void> {
  try {
    const ids = await queuedFinalEmailIds();
    await queueFinalEmailJobs(ids);
    if (ids.length > 0) console.info(`Queued ${ids.length} final emails not sent before`);
  } catch (error) {
    console.error("Could not queue the waiting final emails:", describeError(error));
  }
}
