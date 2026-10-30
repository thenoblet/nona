import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { dbConfig } from "@/lib/env";
import { initialRsvpState } from "@/components/rsvp/options";
import { resetDb } from "../../../../test/db";

vi.mock("@/lib/content/get", () => ({
  getSiteContent: async () => contentDefaults,
}));

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    Promise.resolve()
      .then(fn)
      .catch(() => {});
  },
}));

const boss = vi.hoisted(() => ({ send: vi.fn(), fail: false }));
vi.mock("@/lib/jobs/boss", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/jobs/boss")>();
  return {
    ...real,
    getBoss: async () => ({
      send: async (...args: unknown[]) => {
        if (boss.fail) throw new Error("queue is down");
        boss.send(...args);
        return "job-1";
      },
    }),
  };
});

const saveRsvp = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("@/lib/data/rsvp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/data/rsvp")>();
  return {
    ...real,
    saveRsvp: (input: Parameters<typeof real.saveRsvp>[0]) => {
      if (saveRsvp.failure) return Promise.reject(saveRsvp.failure);
      return real.saveRsvp(input);
    },
  };
});

import { submitRsvp } from "./actions";

function form(extra: Record<string, string> = {}) {
  const data = new FormData();
  const fields = {
    fullName: "Ama Test",
    phone: "024 000 0000",
    partySize: "Just me",
    [`answer-${contentDefaults.celebrations[0].id}`]: "yes",
    ...extra,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function rows() {
  const sql = postgres({ ...dbConfig(), max: 1 });
  try {
    return await sql<{ email: string | null }[]>`SELECT email FROM rsvps`;
  } finally {
    await sql.end();
  }
}

describe("submitRsvp", () => {
  beforeEach(async () => {
    saveRsvp.failure = null;
    boss.fail = false;
    boss.send.mockClear();
    await resetDb();
  });

  it("saves a reply with an email", async () => {
    const state = await submitRsvp(
      initialRsvpState,
      form({ email: "ama@example.com" }),
    );
    expect(state.status).toBe("sent");
    expect(await rows()).toEqual([{ email: "ama@example.com" }]);
  });

  it("saves a reply without an email", async () => {
    const state = await submitRsvp(initialRsvpState, form({ email: "" }));
    expect(state.status).toBe("sent");
    expect(await rows()).toEqual([{ email: null }]);
  });

  it("rejects an email that is not one", async () => {
    const state = await submitRsvp(
      initialRsvpState,
      form({ email: "not-an-email" }),
    );
    expect(state.status).toBe("error");
    expect(state.errors.email).toBe(
      "That email doesn't look right. Could you check it?",
    );
    expect(await rows()).toEqual([]);
  });

  it("says so when the reply could not be saved", async () => {
    saveRsvp.failure = new Error("database is down");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await submitRsvp(initialRsvpState, form());
    expect(state.status).toBe("error");
    expect(state.errors.form).toBe(
      "Sorry, your reply didn't reach us. Please try again in a moment.",
    );
  });

  it("logs no guest details when the save fails", async () => {
    // Drizzle's query errors repeat the query's parameters: the guest's name, phone and email.
    const cause = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    saveRsvp.failure = Object.assign(
      new Error('Failed query: insert into "rsvps" params: Ama Test,024 000 0000,ama@example.com'),
      { name: "DrizzleQueryError", cause },
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    expect(state.status).toBe("error");
    expect(log).toHaveBeenCalled();
    const logged = log.mock.calls.flat().map((argument) =>
      argument instanceof Error ? `${argument.message} ${String(argument.cause)}` : String(argument),
    );
    expect(logged.join(" ")).not.toContain("example.com");
    expect(logged.join(" ")).not.toContain("Ama Test");
  });

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  it("queues a confirmation when an email was given", async () => {
    await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    await settle();
    expect(boss.send).toHaveBeenCalledOnce();
    expect(boss.send.mock.calls[0][0]).toBe("email-rsvp-confirmation");
  });

  it("queues nothing without an email", async () => {
    await submitRsvp(initialRsvpState, form({ email: "" }));
    await settle();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("still returns sent when the queue is down", async () => {
    boss.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await submitRsvp(
      initialRsvpState,
      form({ email: "ama@example.com" }),
    );
    await settle();
    expect(state.status).toBe("sent");
  });

  it("answers a second reply from the same guest exactly as it answered the first", async () => {
    const first = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    const second = await submitRsvp(
      initialRsvpState,
      form({ email: "ama@example.com", phone: "+233 24 000 0000", song: "Odo" }),
    );
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    expect(second).toEqual({ ...first, values: { ...first.values, phone: "+233 24 000 0000", song: "Odo" } });
    expect(await rows()).toHaveLength(2);
    await settle();
  });

  it("keeps one reply and queues one confirmation when the same reply is sent twice", async () => {
    await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    await settle();
    await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    await settle();
    expect(await rows()).toHaveLength(1);
    expect(boss.send).toHaveBeenCalledOnce();
  });

  it("keeps one reply and queues one confirmation when the same reply is sent twice at once", async () => {
    await Promise.all([
      submitRsvp(initialRsvpState, form({ email: "ama@example.com" })),
      submitRsvp(initialRsvpState, form({ email: "ama@example.com" })),
    ]);
    await settle();
    expect(await rows()).toHaveLength(1);
    expect(boss.send).toHaveBeenCalledOnce();
  });

  it("keeps yes, no, then yes again as three replies, each with its confirmation", async () => {
    const answer = `answer-${contentDefaults.celebrations[0].id}`;
    for (const value of ["yes", "no", "yes"]) {
      await submitRsvp(initialRsvpState, form({ email: "ama@example.com", [answer]: value }));
      await settle();
    }
    expect(await rows()).toHaveLength(3);
    expect(boss.send).toHaveBeenCalledTimes(3);
  });

  it("queues no fourth email to the same address within 24 hours", async () => {
    for (let index = 0; index < 4; index++) {
      await submitRsvp(
        initialRsvpState,
        form({ email: "ama@example.com", song: `Song ${index}` }),
      );
      await settle();
    }
    expect(boss.send).toHaveBeenCalledTimes(3);
  });
});
