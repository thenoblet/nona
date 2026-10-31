import { CONFIRMATION_QUEUE, getBoss, QUEUES } from "./boss";
import { handleRsvpConfirmation } from "./handle-rsvp-confirmation";
import { createMediaQueues } from "./media-queues";
import { requeueUnsentConfirmations } from "./rsvp-confirmation";

/**
 * Starts the job queue's workers. Called from instrumentation.ts, in the background. The media
 * queues are created here too, so the app can send media jobs before the worker first runs, but
 * their jobs are the worker's: the app starts no media worker.
 */
export async function startJobs(): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
  // createQueue leaves a queue that already exists as it was, so bring its settings up to date.
  await boss.updateQueue(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
  // Before any worker starts: a failure here retries the whole start-up, which must not leave a
  // second confirmation worker running.
  await createMediaQueues(boss);
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
