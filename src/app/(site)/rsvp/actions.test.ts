import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { dbConfig } from "@/lib/env";
import { initialRsvpState } from "@/components/rsvp/options";
import { createGuest, findGuestById } from "@/lib/data/guests";
import { resetDb } from "../../../../test/db";
import { browserCookies } from "../../../../test/next-cookies";

// One browser's cookie jar: what it sent, and the Set-Cookie the action answered with.
vi.mock("next/headers", () => import("../../../../test/next-cookies"));

// The site text is read from the test database as on the site; outside Next, "use cache" is a
// plain call. A test can make the read fail, as it would while the database is unreachable.
vi.mock("next/cache", () => ({ cacheTag: vi.fn(), cacheLife: vi.fn() }));
const contentRead = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("@/lib/content/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/content/store")>();
  return {
    ...real,
    readSiteContent: () => (contentRead.failure ? Promise.reject(contentRead.failure) : real.readSiteContent()),
  };
});

// after() runs its task once the response is sent; the tests wait for exactly those tasks.
const afterTasks = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    afterTasks.push(Promise.resolve().then(task));
  },
}));

/** Waits for every task the action handed to after(). */
async function settle() {
  await Promise.all(afterTasks.splice(0));
}

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

import { getSiteContent } from "@/lib/content/get";
import { saveSection } from "@/lib/content/store";
import { guestCookieName, readGuestIds, signGuestIds } from "@/lib/guests/cookie";
import { submitRsvp } from "./actions";

const TRY_AGAIN = "Sorry, your reply didn't reach us. Please try again in a moment.";

async function closeReplies() {
  await saveSection("rsvp", { ...contentDefaults.rsvp, open: false }, "test");
}

/** Lets the 30 s fallback after a failed read run out, and reads once, so no later test gets it. */
async function endFallbackWindow() {
  vi.advanceTimersByTime(30_000);
  await getSiteContent();
}

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

async function savedAnswers() {
  const sql = postgres({ ...dbConfig(), max: 1 });
  try {
    return (await sql<{ answers: Record<string, string> }[]>`SELECT answers FROM rsvps`).map((row) => row.answers);
  } finally {
    await sql.end();
  }
}

/** Each saved reply's guest, oldest first. */
async function replyGuests() {
  const sql = postgres({ ...dbConfig(), max: 1 });
  try {
    return (await sql<{ guest_id: string | null }[]>`SELECT guest_id FROM rsvps ORDER BY received_at`).map((row) => row.guest_id);
  } finally {
    await sql.end();
  }
}

async function guestCount(): Promise<number> {
  const sql = postgres({ ...dbConfig(), max: 1 });
  try {
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM guests`;
    return count;
  } finally {
    await sql.end();
  }
}

/** The browser sends a guest cookie with these ids, its own first. */
function sendCookie(ids: string[]) {
  browserCookies.values.set(guestCookieName(), signGuestIds(ids));
}

const [firstCelebration] = contentDefaults.celebrations;

describe("submitRsvp", () => {
  beforeEach(async () => {
    contentRead.failure = null;
    saveRsvp.failure = null;
    boss.fail = false;
    boss.send.mockClear();
    afterTasks.length = 0;
    browserCookies.clear();
    await resetDb();
  });

  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
  });

  it("saves a reply with an email", async () => {
    const state = await submitRsvp(
      initialRsvpState,
      form({ email: "ama@example.com" }),
    );
    expect(state.status).toBe("sent");
    expect(await rows()).toEqual([{ email: "ama@example.com" }]);
  });

  it("refuses a reply once replies are closed, with the closed message, and saves and queues nothing", async () => {
    await closeReplies();
    const state = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    expect(state.status).toBe("error");
    expect(state.errors).toEqual({ form: contentDefaults.rsvp.closedMessage });
    expect(state.values.fullName).toBe("Ama Test");
    await settle();
    expect(await rows()).toEqual([]);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("gives only the closed message, not the form's problems, once replies are closed", async () => {
    await closeReplies();
    const state = await submitRsvp(initialRsvpState, form({ fullName: "", email: "not-an-email" }));
    expect(state.errors).toEqual({ form: contentDefaults.rsvp.closedMessage });
    expect(await rows()).toEqual([]);
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

  it("keeps only the answers for celebrations that exist", async () => {
    const state = await submitRsvp(initialRsvpState, form({ "answer-party": "yes", "answer-__proto__": "yes" }));
    expect(state.status).toBe("sent");
    expect(await savedAnswers()).toEqual([{ [firstCelebration.id]: "yes" }]);
  });

  it("asks for an answer when none is a yes or no to a celebration that exists", async () => {
    const state = await submitRsvp(
      initialRsvpState,
      form({ [`answer-${firstCelebration.id}`]: "maybe", "answer-party": "yes" }),
    );
    expect(state.status).toBe("error");
    expect(state.errors.answers).toBe("Please let us know about at least one celebration.");
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

  it("checks whether replies are open against the database, even while pages show the built-in text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A failed read: for 30 s pages show the built-in text, in which replies are open.
      contentRead.failure = new Error("database is down");
      await getSiteContent();
      contentRead.failure = null;
      await closeReplies();
      expect((await getSiteContent()).rsvp.open).toBe(true);

      const state = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      expect(state.errors).toEqual({ form: contentDefaults.rsvp.closedMessage });
      expect(await rows()).toEqual([]);
    } finally {
      await endFallbackWindow();
      vi.useRealTimers();
    }
  });

  it("asks the guest to try again, keeping what was typed, when it can't tell whether replies are open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    contentRead.failure = new Error("database is down");
    const state = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
    contentRead.failure = null;

    // Neither the closed message (replies may well be open) nor a save.
    expect(state.status).toBe("error");
    expect(state.errors).toEqual({ form: TRY_AGAIN });
    expect(state.values).toMatchObject({ fullName: "Ama Test", email: "ama@example.com", answers: { [firstCelebration.id]: "yes" } });
    await settle();
    expect(await rows()).toEqual([]);
    expect(boss.send).not.toHaveBeenCalled();
    // Pages were not switched to the built-in text by this check.
    expect((await getSiteContent()).faq).toEqual(contentDefaults.faq);
  });

  describe("the reply's guest (Ruling BY)", () => {
    it("gives a browser without a guest one named after the reply, sets the guest cookie, and keeps the guest on the reply", async () => {
      const state = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      expect(state.status).toBe("sent");
      const [guestId] = await replyGuests();
      expect(guestId).toEqual(expect.any(String));
      expect((await findGuestById(guestId!))?.displayName).toBe("Ama Test");
      expect(browserCookies.sets.map((cookie) => cookie.name)).toEqual([guestCookieName()]);
      expect(await readGuestIds()).toEqual([guestId]);
    });

    it("gives a reply without an email the browser's guest too", async () => {
      await submitRsvp(initialRsvpState, form({ email: "" }));
      const [guestId] = await replyGuests();
      expect(await readGuestIds()).toEqual([guestId]);
    });

    it("reuses the browser's own unnamed guest, naming it after the reply, and leaves the cookie", async () => {
      const own = await createGuest(null);
      sendCookie([own.id]);
      await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      expect(await replyGuests()).toEqual([own.id]);
      expect((await findGuestById(own.id))?.displayName).toBe("Ama Test");
      expect(await guestCount()).toBe(1);
      expect(browserCookies.sets).toEqual([]);
    });

    it("reuses the browser's own guest of the same name, trimmed and in any case, without renaming it", async () => {
      const own = await createGuest("AMA TEST");
      sendCookie([own.id]);
      await submitRsvp(initialRsvpState, form({ fullName: "  ama test ", email: "ama@example.com" }));
      expect(await replyGuests()).toEqual([own.id]);
      expect((await findGuestById(own.id))?.displayName).toBe("AMA TEST");
      expect(await guestCount()).toBe(1);
      expect(browserCookies.sets).toEqual([]);
    });

    it("gives a reply under another name on the same phone a separate guest, and leaves the browser's own and its cookie", async () => {
      const own = await createGuest("Kofi Test");
      sendCookie([own.id]);
      await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      const [guestId] = await replyGuests();
      expect(guestId).not.toBe(own.id);
      expect((await findGuestById(guestId!))?.displayName).toBe("Ama Test");
      expect((await findGuestById(own.id))?.displayName).toBe("Kofi Test");
      expect(browserCookies.sets).toEqual([]);
      expect(await readGuestIds()).toEqual([own.id]);
    });

    it("makes no guest and sets no cookie while replies are closed", async () => {
      await closeReplies();
      await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      expect(await guestCount()).toBe(0);
      expect(browserCookies.sets).toEqual([]);
    });

    it("makes no guest and sets no cookie for a reply the form sends back to fix", async () => {
      await submitRsvp(initialRsvpState, form({ fullName: "A", email: "ama@example.com" }));
      await submitRsvp(initialRsvpState, form({ email: "not-an-email" }));
      expect(await guestCount()).toBe(0);
      expect(browserCookies.sets).toEqual([]);
    });

    it("still saves the reply, without a guest, when the guest can't be made, and logs no guest details", async () => {
      // Production without the cookie's secret: the guest cookie can be neither read nor signed.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GUEST_COOKIE_SECRET", "");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const state = await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
        expect(state.status).toBe("sent");
        expect(await replyGuests()).toEqual([null]);
        expect(browserCookies.sets).toEqual([]);
        expect(log).toHaveBeenCalled();
        const logged = log.mock.calls.flat().map(String).join(" ");
        expect(logged).not.toContain("Ama Test");
        expect(logged).not.toContain("example.com");
      } finally {
        vi.unstubAllEnvs();
      }
      await settle();
      expect(boss.send).toHaveBeenCalledOnce();
    });

    it("keeps the first reply's guest when the same reply is sent twice from one browser", async () => {
      await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      await submitRsvp(initialRsvpState, form({ email: "ama@example.com" }));
      const guests = await replyGuests();
      expect(guests).toHaveLength(1);
      expect(await readGuestIds()).toEqual(guests);
      expect(await guestCount()).toBe(1);
    });
  });
});
