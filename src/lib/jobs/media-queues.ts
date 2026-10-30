import type { PgBoss, Queue } from "pg-boss";

/**
 * The media worker's queues. The app only sends to them; the worker (its own process) takes the
 * jobs. Both create them at start-up, so whichever starts first can send.
 */
export const MEDIA_QUEUES = {
  photo: "media.photo",
  jpeg: "media.jpeg",
  poster: "media.poster",
  wish: "media.wish",
  convert: "media.convert",
  visibility: "media.visibility",
  card: "media.card",
  dead: "media.dead",
} as const;

export type MediaQueueName = (typeof MEDIA_QUEUES)[keyof typeof MEDIA_QUEUES];

/**
 * A queue's options. createQueue takes them all; updateQueue takes all but the policy, which
 * pg-boss fixes when the queue is created and refuses to change after.
 */
type MediaQueueOptions = Omit<Queue, "name" | "partition"> & { policy: "standard" };

/**
 * Every queue: a standard queue (priorities, which the conversions use), whose jobs the worker
 * heartbeats; pg-boss retries a job if a minute passes without one (a crashed or killed worker).
 * Every option is stated, even pg-boss's default, so updateQueue puts right any that drifted.
 */
const EVERY_QUEUE = {
  // Fixed at creation: changing it would mean deleting the queue and its jobs.
  policy: "standard",
  heartbeatSeconds: 60,
} as const satisfies Partial<MediaQueueOptions>;

/**
 * A job's transient error is retried 12 times, the waits doubling from 30 s (plus up to as much
 * again at random) to at most 30 minutes: 3½ to 4 hours in all, well inside the 14 days pg-boss
 * keeps a job waiting. A permanent error (a corrupt file) is the worker's to fail at once, without
 * retries. A job out of retries goes to media.dead, whose handler marks its item failed with the
 * reason. Each attempt may run 15 minutes (pg-boss's default), a conversion 4 hours.
 */
const JOB_QUEUE = {
  ...EVERY_QUEUE,
  retryLimit: 12,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 1800,
  expireInSeconds: 15 * 60,
  deadLetter: MEDIA_QUEUES.dead,
} as const satisfies MediaQueueOptions;

export const MEDIA_QUEUE_OPTIONS: Readonly<Record<MediaQueueName, MediaQueueOptions>> = {
  [MEDIA_QUEUES.photo]: JOB_QUEUE,
  [MEDIA_QUEUES.jpeg]: JOB_QUEUE,
  [MEDIA_QUEUES.poster]: JOB_QUEUE,
  [MEDIA_QUEUES.wish]: JOB_QUEUE,
  [MEDIA_QUEUES.convert]: { ...JOB_QUEUE, expireInSeconds: 4 * 60 * 60 },
  [MEDIA_QUEUES.visibility]: JOB_QUEUE,
  [MEDIA_QUEUES.card]: JOB_QUEUE,
  // The dead-letter handler only marks an item failed, so a few flat retries a minute apart. Flat
  // because pg-boss's dead-letter copies don't carry retryDelayMax: backoff would be uncapped.
  [MEDIA_QUEUES.dead]: {
    ...EVERY_QUEUE,
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 15 * 60,
  },
};

// media.dead first: the others name it as their dead letter queue, and pg-boss refuses one that
// doesn't exist yet.
const CREATION_ORDER: MediaQueueName[] = [
  MEDIA_QUEUES.dead,
  ...Object.values(MEDIA_QUEUES).filter((name) => name !== MEDIA_QUEUES.dead),
];

/**
 * Creates the media queues, or brings existing ones up to these options. Safe to run any number
 * of times, from the app and the worker at once: createQueue leaves an existing queue as it was,
 * so updateQueue applies the options (all but the policy, which can't change).
 */
export async function createMediaQueues(boss: Pick<PgBoss, "createQueue" | "updateQueue">): Promise<void> {
  for (const name of CREATION_ORDER) {
    const { policy, ...updatable } = MEDIA_QUEUE_OPTIONS[name];
    await boss.createQueue(name, { policy, ...updatable });
    await boss.updateQueue(name, updatable);
  }
}
