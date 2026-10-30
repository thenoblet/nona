import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the started pg-boss: it records what the app asks of it, in order.
const queue = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    createQueue: vi.fn(async () => {
      order.push("createQueue");
    }),
    updateQueue: vi.fn(async () => {
      order.push("updateQueue");
    }),
    work: vi.fn(async () => {
      order.push("work");
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
vi.mock("./rsvp-confirmation", () => ({
  requeueUnsentConfirmations: async () => {
    queue.order.push("requeue");
  },
}));

import { CONFIRMATION_QUEUE, QUEUES } from "./boss";
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
});

describe("startJobs", () => {
  it("brings the confirmation queue up to date, starts its worker, then re-queues unsent confirmations", async () => {
    await startJobs();
    expect(queue.createQueue).toHaveBeenCalledWith(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
    // createQueue leaves an existing queue's settings alone; updateQueue applies the new ones.
    expect(queue.updateQueue).toHaveBeenCalledWith(QUEUES.rsvpConfirmation, CONFIRMATION_QUEUE);
    expect(queue.order).toEqual(["createQueue", "updateQueue", "work", "requeue"]);
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
