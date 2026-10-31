import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PURGE_FILES_PER_CALL, PURGE_TIMEOUT_MILLISECONDS, PurgeNotConfiguredError, purgeUrls } from "./purge";

/*
 * Cloudflare's purge_cache, played by a local HTTP server: the tests never reach the real API.
 */

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-purge-token-not-a-secret";

type ReceivedCall = { method: string; path: string; authorization: string | undefined; contentType: string | undefined; body: unknown };

const stub = {
  calls: [] as ReceivedCall[],
  /** How the stub answers each call: Cloudflare's success by default. */
  answer: (_call: ReceivedCall, response: ServerResponse) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, errors: [], messages: [], result: { id: "purge-id" } }));
  },
};

let server: Server;
let apiUrl: string;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const text = await readBody(request);
    const call: ReceivedCall = {
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: text ? JSON.parse(text) : null,
    };
    stub.calls.push(call);
    stub.answer(call, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const defaultAnswer = stub.answer;
beforeEach(() => {
  stub.calls = [];
  stub.answer = defaultAnswer;
});

function urls(count: number): string[] {
  return Array.from({ length: count }, (_empty, index) => `https://media.example.com/derived/item/hash/file-${index}.webp`);
}

const configured = { CF_PURGE_TOKEN: TOKEN, CF_ZONE_ID: ZONE_ID, NODE_ENV: "production" };

describe("purgeUrls", () => {
  it("posts the URLs to the zone's purge_cache as { files }, 30 a call, with the token as a bearer", async () => {
    const files = urls(65);

    const result = await purgeUrls(files, { env: configured, apiUrl });

    expect(result).toEqual({ purged: 65 });
    expect(PURGE_FILES_PER_CALL).toBe(30);
    expect(stub.calls.map((call) => (call.body as { files: string[] }).files)).toEqual([
      files.slice(0, 30),
      files.slice(30, 60),
      files.slice(60),
    ]);
    for (const call of stub.calls) {
      expect(call).toMatchObject({
        method: "POST",
        path: `/client/v4/zones/${ZONE_ID}/purge_cache`,
        authorization: `Bearer ${TOKEN}`,
        contentType: "application/json",
      });
    }
  });

  it("sends nothing for no URLs", async () => {
    expect(await purgeUrls([], { env: configured, apiUrl })).toEqual({ purged: 0 });
    expect(stub.calls).toEqual([]);
  });

  it("throws when Cloudflare refuses, naming its errors but never the token", async () => {
    stub.answer = (_call, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
    };

    const failure = await purgeUrls(urls(2), { env: configured, apiUrl }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/403.*10000 Authentication error/);
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it("throws when Cloudflare answers 200 but not success", async () => {
    stub.answer = (_call, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ code: 1012, message: "Request must contain one of files" }] }));
    };

    await expect(purgeUrls(urls(1), { env: configured, apiUrl })).rejects.toThrow(/1012/);
  });

  it("stops at the first refused call, leaving the rest for the job's retry", async () => {
    stub.answer = (call, response) => {
      const failing = stub.calls.length === 2;
      response.writeHead(failing ? 429 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: !failing, errors: failing ? [{ code: 971, message: "Please wait" }] : [] }));
    };

    await expect(purgeUrls(urls(90), { env: configured, apiUrl })).rejects.toThrow(/429/);
    expect(stub.calls).toHaveLength(2);
  });

  it("gives each call 10 s, then gives up", async () => {
    stub.answer = () => {
      // Never answers.
    };
    expect(PURGE_TIMEOUT_MILLISECONDS).toBe(10_000);

    const startedAt = performance.now();
    await expect(purgeUrls(urls(1), { env: configured, apiUrl, timeoutMilliseconds: 300 })).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("ends when the caller's signal does (the job's)", async () => {
    stub.answer = () => {};
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("The job expired")), 100);

    await expect(purgeUrls(urls(1), { env: configured, apiUrl, signal: controller.signal })).rejects.toThrow();
  });

  it("fails in production without CF_PURGE_TOKEN or CF_ZONE_ID, so the job is retried and the gap is seen", async () => {
    for (const env of [
      { NODE_ENV: "production", CF_ZONE_ID: ZONE_ID },
      { NODE_ENV: "production", CF_PURGE_TOKEN: TOKEN },
      { NODE_ENV: "production", CF_PURGE_TOKEN: " ", CF_ZONE_ID: ZONE_ID },
    ]) {
      await expect(purgeUrls(urls(1), { env, apiUrl })).rejects.toBeInstanceOf(PurgeNotConfiguredError);
    }
    expect(stub.calls).toEqual([]);
  });

  it("is skipped outside production when either is missing", async () => {
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test", CF_PURGE_TOKEN: TOKEN }, {}]) {
      expect(await purgeUrls(urls(1), { env, apiUrl })).toEqual({ skipped: "not-configured" });
    }
    expect(stub.calls).toEqual([]);
  });

  it("purges outside production too once both are set", async () => {
    expect(await purgeUrls(urls(1), { env: { ...configured, NODE_ENV: "test" }, apiUrl })).toEqual({ purged: 1 });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses a zone id that isn't one, so nothing else lands in the API's path", async () => {
    await expect(purgeUrls(urls(1), { env: { ...configured, CF_ZONE_ID: "../accounts/x" }, apiUrl })).rejects.toThrow(/CF_ZONE_ID/);
    expect(stub.calls).toEqual([]);
  });
});
