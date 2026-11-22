import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the started pg-boss: it records what the app asks of it, in order.
const queue = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    createQueue: vi.fn(async (name: string) => {
      order.push(`createQueue ${name}`);
    }),
    updateQueue: vi.fn(async (name: string) => {
      order.push(`updateQueue ${name}`);
    }),
    work: vi.fn(async (name: string) => {
      order.push(`work ${name}`);
      return "worker";
    }),
  };
});
vi.mock("./boss", async (importOriginal) => {
  const real = await importOriginal<typeof import("./boss")>();
  return {
    ...real,
    getBoss: async () => ({
      createQueue: queue.createQueue,
      updateQueue: queue.updateQueue,
      work: queue.work,
    }),
  };
});

const confirmations = vi.hoisted(() => ({
  handle: vi.fn(async () => {}),
}));
vi.mock("./handle-rsvp-confirmation", () => ({
  handleRsvpConfirmation: confirmations.handle,
}));
const finals = vi.hoisted(() => ({
  handle: vi.fn(async () => {}),
}));
vi.mock("./handle-final-email", () => ({
  handleFinalEmail: finals.handle,
}));
vi.mock("./final-emails", () => ({
  requeueWaitingFinalEmails: async () => {
    queue.order.push("requeue final");
  },
}));
vi.mock("./rsvp-confirmation", () => ({
  requeueUnsentConfirmations: async () => {
    queue.order.push("requeue");
  },
}));

import { CONFIRMATION_QUEUE, FINAL_EMAIL_QUEUE, QUEUES } from "./boss";
import { MEDIA_QUEUE_OPTIONS, MEDIA_QUEUES } from "./media-queues";
import { startJobs } from "./start-jobs";

type ConfirmationWorker = (
  jobs: { data: { rsvpId: string }; retryCount: number; retryLimit: number }[],
) => Promise<void>;

beforeEach(() => {
  queue.order.length = 0;
  queue.createQueue.mockClear();
  queue.updateQueue.mockClear();
  queue.work.mockClear();
  confirmations.handle.mockClear();
  finals.handle.mockClear();
});

describe("startJobs", () => {
  it("brings the confirmation queue up to date, starts its worker, then re-queues unsent confirmations", async () => {
    await startJobs();
    expect(queue.createQueue).toHaveBeenCalledWith(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
    // createQueue leaves an existing queue's settings alone; updateQueue applies the new ones.
    expect(queue.updateQueue).toHaveBeenCalledWith(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
    const confirmationSteps = queue.order.filter((step) => !step.includes(" media."));
    expect(confirmationSteps).toEqual([
      `createQueue ${QUEUES.rsvpConfirmation}`,
      `updateQueue ${QUEUES.rsvpConfirmation}`,
      `createQueue ${QUEUES.finalEmail}`,
      `updateQueue ${QUEUES.finalEmail}`,
      `work ${QUEUES.rsvpConfirmation}`,
      `work ${QUEUES.finalEmail}`,
      "requeue final",
      "requeue",
    ]);
  });

  it("brings the final emails' queue up to date and hands each job's email and attempt to its handler", async () => {
    await startJobs();
    expect(queue.createQueue).toHaveBeenCalledWith(QUEUES.finalEmail, FINAL_EMAIL_QUEUE);
    expect(queue.updateQueue).toHaveBeenCalledWith(QUEUES.finalEmail, FINAL_EMAIL_QUEUE);
    const [, options, worker] = queue.work.mock.calls[1] as unknown as [
      string,
      unknown,
      (jobs: { data: { id: string }; retryCount: number; retryLimit: number }[]) => Promise<void>,
    ];
    expect(options).toEqual({ includeMetadata: true });
    await worker([{ data: { id: "email-1" }, retryCount: 1, retryLimit: 13 }]);
    expect(finals.handle.mock.calls).toEqual([["email-1", { retryCount: 1, retryLimit: 13 }]]);
  });

  it("creates every media queue with its options, so the app can send media jobs before the worker first runs", async () => {
    await startJobs();
    for (const name of Object.values(MEDIA_QUEUES)) {
      expect(queue.createQueue).toHaveBeenCalledWith(name, MEDIA_QUEUE_OPTIONS[name]);
      // updateQueue refuses a policy, which can't change after creation; it gets everything else.
      const { policy, ...updatable } = MEDIA_QUEUE_OPTIONS[name];
      expect(policy).toBe("standard");
      expect(queue.updateQueue).toHaveBeenCalledWith(name, updatable);
    }
    // Before any worker starts: a failure here retries the whole start-up, which must not leave a
    // second confirmation worker running.
    const lastMediaStep = Math.max(...queue.order.flatMap((step, index) => (step.includes(" media.") ? [index] : [])));
    expect(lastMediaStep).toBeLessThan(queue.order.indexOf(`work ${QUEUES.rsvpConfirmation}`));
  });

  it("starts no media worker: the media worker takes those jobs", async () => {
    await startJobs();
    expect(queue.work.mock.calls.map(([name]) => name)).toEqual([QUEUES.rsvpConfirmation, QUEUES.finalEmail]);
  });

  it("hands each job's reply and attempt to the confirmation's handler, one job after another", async () => {
    await startJobs();
    const [queueName, options, worker] = queue.work.mock.calls[0] as unknown as [
      string,
      unknown,
      ConfirmationWorker,
    ];
    expect(queueName).toBe(QUEUES.rsvpConfirmation);
    expect(options).toEqual({ includeMetadata: true });
    await worker([
      { data: { rsvpId: "first" }, retryCount: 2, retryLimit: 13 },
      { data: { rsvpId: "second" }, retryCount: 0, retryLimit: 13 },
    ]);
    expect(confirmations.handle.mock.calls).toEqual([
      ["first", { retryCount: 2, retryLimit: 13 }],
      ["second", { retryCount: 0, retryLimit: 13 }],
    ]);
  });
});
