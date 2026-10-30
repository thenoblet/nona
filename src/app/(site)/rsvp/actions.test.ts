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

const saveRsvp = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/data/rsvp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/data/rsvp")>();
  return {
    ...real,
    saveRsvp: (input: Parameters<typeof real.saveRsvp>[0]) => {
      if (saveRsvp.fail) return Promise.reject(new Error("database is down"));
      return real.saveRsvp(input);
    },
  };
});

import { submitRsvp } from "./actions";

function form(extra: Record<string, string> = {}) {
  const f = new FormData();
  const fields = {
    fullName: "Ama Test",
    phone: "024 000 0000",
    partySize: "Just me",
    [`answer-${contentDefaults.celebrations[0].id}`]: "yes",
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
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
    saveRsvp.fail = false;
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
    saveRsvp.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await submitRsvp(initialRsvpState, form());
    expect(state.status).toBe("error");
    expect(state.errors.form).toBe(
      "Sorry, your reply didn't reach us. Please try again in a moment.",
    );
  });

  async function settle() {
    await new Promise((r) => setTimeout(r, 200));
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

  it("queues no fourth email to the same address within 24 hours", async () => {
    for (let i = 0; i < 4; i++) {
      await submitRsvp(
        initialRsvpState,
        form({ email: "ama@example.com", song: `Song ${i}` }),
      );
      await settle();
    }
    expect(boss.send).toHaveBeenCalledTimes(3);
  });
});
