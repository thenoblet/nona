import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "./api";

type Answer = Response | Error | "hang";

/** A fetch that answers from a script, one answer per call, and records each request. */
function scriptedFetch(answers: Answer[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("No answer left in the script");
    if (answer === "hang") {
      // Never answers: only its signal ends it, as a stalled connection.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function clientWith(answers: Answer[]) {
  const scripted = scriptedFetch(answers);
  const waits: number[] = [];
  const client = createApiClient({
    fetch: scripted.fetch,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  return { client, requests: scripted.requests, waits };
}

describe("the uploader's API client", () => {
  it("sends JSON to its own site and returns the answer's status and body", async () => {
    const { client, requests } = clientWith([json(200, { mediaId: "m" })]);

    const answer = await client.request("/api/uploads", { method: "POST", body: { size: 1 }, timeoutMs: 10_000 });

    expect(answer).toEqual({ status: 200, body: { mediaId: "m" } });
    expect(requests[0].url).toBe("/api/uploads");
    expect(requests[0].init).toMatchObject({ method: "POST", body: JSON.stringify({ size: 1 }), credentials: "same-origin" });
    expect(new Headers(requests[0].init.headers).get("Content-Type")).toBe("application/json");
  });

  it("waits out a 429's Retry-After and asks again, so the guest never sees it", async () => {
    const { client, waits } = clientWith([
      json(429, { error: "rate-limited", retryAfterSeconds: 3 }, { "Retry-After": "3" }),
      json(429, { error: "rate-limited", retryAfterSeconds: 2 }),
      json(200, { urls: [] }),
    ]);

    const answer = await client.request("/api/uploads/m/parts", { method: "POST", body: {}, timeoutMs: 10_000 });

    expect(answer.status).toBe(200);
    expect(waits).toEqual([3000, 2000]);
  });

  it("tries again after a dropped connection or a server that is briefly down, waiting longer each time", async () => {
    const { client, waits } = clientWith([new TypeError("Failed to fetch"), json(503, { error: "unavailable" }), json(200, {})]);

    expect((await client.request("/api/uploads", { method: "POST", body: {}, timeoutMs: 10_000 })).status).toBe(200);
    expect(waits).toEqual([1000, 3000]);
  });

  it("gives up after its tries with a network error the uploader can retry later", async () => {
    const { client, requests } = clientWith([
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
    ]);

    const failure = await client.request("/api/uploads", { method: "POST", body: {}, timeoutMs: 10_000 }).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ kind: "network" });
    expect(requests).toHaveLength(4);
  });

  it("ends an attempt that takes longer than its timeout, and tries again", async () => {
    const { client } = clientWith(["hang", json(200, { ok: true })]);

    const answer = await client.request("/api/guest", { method: "POST", body: {}, timeoutMs: 20 });

    expect(answer.body).toEqual({ ok: true });
  });

  it("stops at once, without trying again, when the uploader cancels", async () => {
    const { client, requests } = clientWith(["hang", json(200, {})]);
    const cancel = new AbortController();

    const pending = client.request("/api/uploads/m/complete", { method: "POST", body: {}, timeoutMs: 60_000, signal: cancel.signal });
    cancel.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  });

  it("returns any other answer as it is, for the uploader to read", async () => {
    const { client } = clientWith([json(409, { error: "upload-missing", message: "This upload has expired." })]);

    expect(await client.request("/api/uploads/m/complete", { method: "POST", body: {}, timeoutMs: 10_000 })).toEqual({
      status: 409,
      body: { error: "upload-missing", message: "This upload has expired." },
    });
  });
});
