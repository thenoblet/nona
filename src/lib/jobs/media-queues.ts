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

/** Options both createQueue and updateQueue accept (updateQueue refuses a policy or partition). */
type MediaQueueOptions = Omit<Queue, "name" | "policy" | "partition">;

/**
 * Every queue: the worker heartbeats each job, and pg-boss retries it if a minute passes without
 * one (a crashed or killed worker). A transient error is retried 12 times, the waits doubling from
 * 30 s (plus up to as much again at random) to at most 30 minutes: 3½ to 4 hours in all, well
 * inside the 14 days pg-boss keeps a job waiting. A permanent error (a corrupt file) is the
 * worker's to fail at once, without retries.
 */
const EVERY_QUEUE = {
  heartbeatSeconds: 60,
  retryLimit: 12,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 1800,
} as const satisfies MediaQueueOptions;

/** A job out of retries goes to media.dead, whose handler marks its item failed with the reason. */
const DEAD_LETTER = { deadLetter: MEDIA_QUEUES.dead } as const satisfies MediaQueueOptions;

export const MEDIA_QUEUE_OPTIONS: Readonly<Record<MediaQueueName, MediaQueueOptions>> = {
  [MEDIA_QUEUES.photo]: { ...EVERY_QUEUE, ...DEAD_LETTER },
  [MEDIA_QUEUES.jpeg]: { ...EVERY_QUEUE, ...DEAD_LETTER },
  [MEDIA_QUEUES.poster]: { ...EVERY_QUEUE, ...DEAD_LETTER },
  [MEDIA_QUEUES.wish]: { ...EVERY_QUEUE, ...DEAD_LETTER },
  // A long video's conversion may run for hours; every other job keeps pg-boss's 15 minutes.
  [MEDIA_QUEUES.convert]: { ...EVERY_QUEUE, ...DEAD_LETTER, expireInSeconds: 4 * 60 * 60 },
  [MEDIA_QUEUES.visibility]: { ...EVERY_QUEUE, ...DEAD_LETTER },
  [MEDIA_QUEUES.card]: { ...EVERY_QUEUE, ...DEAD_LETTER },
  // Created first: pg-boss refuses a dead letter queue that doesn't exist yet.
  [MEDIA_QUEUES.dead]: { ...EVERY_QUEUE },
};

// media.dead first, as the others name it as their dead letter queue.
const CREATION_ORDER: MediaQueueName[] = [
  MEDIA_QUEUES.dead,
  ...Object.values(MEDIA_QUEUES).filter((name) => name !== MEDIA_QUEUES.dead),
];

/**
 * Creates the media queues, or brings existing ones up to these options. Safe to run any number
 * of times, from the app and the worker at once: createQueue leaves an existing queue as it was,
 * so updateQueue applies the options.
 */
export async function createMediaQueues(boss: Pick<PgBoss, "createQueue" | "updateQueue">): Promise<void> {
  for (const name of CREATION_ORDER) {
    await boss.createQueue(name, MEDIA_QUEUE_OPTIONS[name]);
    await boss.updateQueue(name, MEDIA_QUEUE_OPTIONS[name]);
  }
}
