import { CONFIRMATION_QUEUE, getBoss, QUEUES } from "./boss";
import { handleRsvpConfirmation } from "./handle-rsvp-confirmation";
import { requeueUnsentConfirmations } from "./rsvp-confirmation";

/** Starts the job queue's workers. Called from instrumentation.ts, in the background. */
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
