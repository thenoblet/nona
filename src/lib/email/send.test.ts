import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resend = vi.hoisted(() => ({
  send: vi.fn(async () => ({ data: { id: "x" }, error: null })),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send };
  },
}));

import { replyToAddresses, sendEmail } from "./send";

const msg = {
  to: "ama@example.com",
  subject: "Hi",
  text: "t",
  html: "<p>t</p>",
};

describe("replyToAddresses", () => {
  it("splits, trims and drops empties", () => {
    expect(replyToAddresses(" a@example.com, b@example.com ,")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(replyToAddresses(undefined)).toEqual([]);
  });
});

describe("sendEmail", () => {
  beforeEach(() => {
    resend.send.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends through Resend with reply-to addresses and the calendar attachment", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_REPLY_TO", "a@example.com,b@example.com");
    await sendEmail({ ...msg, ics: "BEGIN:VCALENDAR" });
    const arg = resend.send.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(arg[0]).toMatchObject({
      from: "Noblet & Nancy <rsvp@nobletxnancy.com>",
      to: "ama@example.com",
      replyTo: ["a@example.com", "b@example.com"],
    });
    const attachments = arg[0].attachments as {
      filename: string;
      content: unknown;
      contentType: string;
    }[];
    expect(attachments[0].filename).toBe("noblet-and-nancy.ics");
    expect(Buffer.isBuffer(attachments[0].content)).toBe(true);
    expect(attachments[0].contentType).toBe("text/calendar; charset=utf-8");
  });

  it("throws when Resend reports an error", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resend.send.mockResolvedValueOnce({
      data: null,
      error: { message: "rate limited" },
    } as never);
    await expect(sendEmail(msg)).rejects.toThrow("rate limited");
  });

  it("rejects in production without a key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendEmail(msg)).rejects.toThrow();
    expect(resend.send).not.toHaveBeenCalled();
  });

  it("logs instead of sending without a key in test", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(sendEmail(msg)).resolves.toBeUndefined();
    expect(resend.send).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain("ama@example.com");
  });
});
