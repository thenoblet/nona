import { describe, expect, it } from "vitest";
import type { RecordedWishState } from "@/app/(site)/wishes/actions";
import { linkWish, type LinkInput, type LinkTimings } from "./link-wish";

const input: LinkInput = { kind: "voice", mediaId: "c0ffee00-0000-4000-8000-000000000001", signedAs: "Ama" };
const sent: RecordedWishState = { status: "sent", sent: { id: "wish-1", signedAs: "Ama" } };

function timings(waits: number[]): LinkTimings {
  return { retryMilliseconds: [1, 2, 3], timeoutMilliseconds: 50, maxRateLimitWaitSeconds: 60, sleep: async (milliseconds) => void waits.push(milliseconds) };
}

describe("linkWish: the wish of an arrived recording", () => {
  it("waits out the guest's limit by its Retry-After and asks again, never showing it", async () => {
    const waits: number[] = [];
    const answers: RecordedWishState[] = [{ status: "rate-limited", retryAfterSeconds: 3 }, sent];
    expect(await linkWish(input, async () => answers.shift() as RecordedWishState, timings(waits))).toEqual(sent);
    expect(waits).toEqual([3_000]);
  });

  it("asks again when an ask gets no answer, or none in time, and says so plainly once its tries are used", async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      if (calls === 2) return new Promise<RecordedWishState>(() => {});
      return sent;
    };
    expect(await linkWish(input, flaky, timings(waits))).toEqual(sent);
    expect(waits).toEqual([1, 2]);

    const never = await linkWish(input, async () => Promise.reject(new TypeError("Failed to fetch")), timings([]));
    expect(never).toEqual({ status: "error", message: "Your wish didn't send. Please try again." });
  });

  it("hands back a refusal or an error at once, without asking again", async () => {
    let calls = 0;
    const refused: RecordedWishState = { status: "refused", message: "We couldn't find your recording. Please record it again." };
    expect(await linkWish(input, async () => (calls += 1, refused), timings([]))).toEqual(refused);
    expect(calls).toBe(1);
  });
});
