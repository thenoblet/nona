import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRsvp, keepReply, saveRsvp, setEmailStatus } from "@/lib/data/rsvp";
import { contentDefaults } from "@/lib/content/defaults";
import { getDb } from "@/lib/db/client";
import { resetDb } from "../../../test/db";

// The RSVP form's action imports this module, so it must never load the email renderer: React Email
// would land in the page's bundle. Rendering and sending live in the job's handler.
vi.mock("@/lib/email/rsvp-confirmation", () => {
  throw new Error("The confirmation's queueing loaded the email renderer");
});

import { queueRsvpConfirmation, requeueUnsentConfirmations } from "./rsvp-confirmation";

const queue = vi.hoisted(() => ({ send: vi.fn(), fail: false, starting: null as Promise<void> | null }));
vi.mock("./boss", () => ({
  QUEUES: { rsvpConfirmation: "email-rsvp-confirmation" },
  getBoss: async () => {
    // A queue still starting: getBoss() has not resolved yet.
    if (queue.starting) await queue.starting;
    return {
      send: async (...args: unknown[]) => {
        if (queue.fail) throw new Error("queue is down for ama@example.com");
        queue.send(...args);
        return "job";
      },
    };
  },
}));

/** Advisory locks held in the test database only: another app's queue on the same server takes its own. */
async function advisoryLocks(): Promise<number> {
  const result = await getDb().execute<{ count: number }>(
    sql`select count(*)::int as count from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())`,
  );
  return result[0].count;
}

const input = {
  fullName: "Ama Test",
  phone: "024 000 0000",
  email: "ama@example.com",
  partySize: "Just me",
  answers: { [contentDefaults.celebrations[0].id]: "yes" as const },
};

describe("queueRsvpConfirmation", () => {
  beforeEach(async () => {
    queue.send.mockReset();
    queue.fail = false;
    queue.starting = null;
    await resetDb();
  });

  it("waits for a starting queue before taking the email's lock", async () => {
    let started = () => {};
    queue.starting = new Promise((resolve) => {
      started = resolve;
    });
    const reply = await saveRsvp(input).then((saved) => saved.record);
    const queuing = queueRsvpConfirmation(reply.id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // While the queue starts, no lock (and no pooled connection in a transaction) is held.
      expect(await advisoryLocks()).toBe(0);
    } finally {
      started();
      await queuing;
    }
    expect(queue.send).toHaveBeenCalledOnce();
    expect((await getRsvp(reply.id))?.emailStatus).toBe("queued");
  });

  it("queues exactly three jobs when five replies share one email at once", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const { record } = await saveRsvp({
        ...input,
        fullName: `Guest ${index}`,
        phone: `024 000 000${index}`,
      });
      ids.push(record.id);
    }
    await Promise.all(ids.map((id) => queueRsvpConfirmation(id)));
    expect(queue.send).toHaveBeenCalledTimes(3);
    const statuses = await Promise.all(
      ids.map(async (id) => (await getRsvp(id))?.emailStatus),
    );
    expect(statuses.filter((status) => status === "queued")).toHaveLength(3);
    expect(statuses.filter((status) => status === "none")).toHaveLength(2);
  });

  it("leaves the reply at none when the job cannot be sent, and logs no address", async () => {
    queue.fail = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const reply = await saveRsvp(input).then((saved) => saved.record);
    await queueRsvpConfirmation(reply.id);
    expect((await getRsvp(reply.id))?.emailStatus).toBe("none");
    expect(JSON.stringify(log.mock.calls)).not.toContain("example.com");
    log.mockRestore();
  });
});

describe("requeueUnsentConfirmations", () => {
  beforeEach(async () => {
    queue.send.mockReset();
    queue.fail = false;
    queue.starting = null;
    await resetDb();
  });

  it("queues the last day's replies that have an email and nothing queued, within the daily cap", async () => {
    const save = (fullName: string, phone: string, email: string | undefined) =>
      saveRsvp({ ...input, fullName, phone, email }).then((saved) => saved.record);
    const unsent = await save("Ama Test", "024 000 0000", "ama@example.com");
    const withoutEmail = await save("Kofi Test", "024 111 1111", undefined);
    const lastWeek = await save("Esi Test", "024 222 2222", "esi@example.com");
    await getDb().execute(sql`update rsvps set received_at = now() - interval '25 hours' where id = ${lastWeek.id}`);
    const alreadySent = await save("Yaw Test", "024 333 3333", "yaw@example.com");
    await setEmailStatus(alreadySent.id, "sent");
    // Three confirmations to one address in a day is the cap, so a fourth stays unsent.
    for (const fullName of ["Abena One", "Abena Two", "Abena Three"]) {
      const capped = await save(fullName, "024 444 4444", "abena@example.com");
      await setEmailStatus(capped.id, "queued");
    }
    const overCap = await save("Abena Four", "024 444 4444", "abena@example.com");
    // A reply moved into another's history needs no confirmation of its own.
    const moved = await save("Kwame Test", "024 555 5555", "kwame@example.com");
    const kept = await saveRsvp({ ...input, fullName: "Kwame Test", phone: "024 555 5555", email: "kwame@example.com", partySize: "2 people" });
    await setEmailStatus(kept.record.id, "sent");
    await keepReply(kept.record.id, [moved.id]);

    await requeueUnsentConfirmations();

    expect(queue.send.mock.calls.map((call) => (call[1] as { rsvpId: string }).rsvpId)).toEqual([unsent.id]);
    expect((await getRsvp(unsent.id))?.emailStatus).toBe("queued");
    for (const reply of [withoutEmail, lastWeek, overCap, moved]) {
      expect((await getRsvp(reply.id))?.emailStatus).toBe("none");
    }
  });

  it("never throws, and logs no address, when the queue is down", async () => {
    queue.fail = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await saveRsvp(input);
    await expect(requeueUnsentConfirmations()).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("example.com");
    log.mockRestore();
  });
});
