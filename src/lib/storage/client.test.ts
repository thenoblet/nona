import { createServer, get, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { CALL_DEADLINE_MILLISECONDS, createStorageClient, cutOffWhenIdle, storageClient, withDeadline } from "./client";

// A stand-in for an R2 edge that misbehaves: /silent accepts the request and never answers,
// /stall answers and then stops sending, /steady sends a little every 100 ms and finishes.
// The idle limit below (1 s) is ten of /steady's gaps, so a busy CI machine won't make it look stalled.
let misbehavingServer: Server;
let port: number;

beforeAll(async () => {
  misbehavingServer = createServer((request, response) => {
    if (request.url === "/stall") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("the first bytes");
    } else if (request.url === "/steady") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const ticker = setInterval(() => {
        response.write("chunk");
        sent += 1;
        if (sent === 8) {
          clearInterval(ticker);
          response.end();
        }
      }, 100);
    }
  });
  await new Promise<void>((resolve) => misbehavingServer.listen(0, "127.0.0.1", resolve));
  port = (misbehavingServer.address() as AddressInfo).port;
});

afterAll(async () => {
  misbehavingServer.closeAllConnections();
  await new Promise((resolve) => misbehavingServer.close(resolve));
});

function download(path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) =>
    get(`http://127.0.0.1:${port}${path}`, resolve).on("error", reject),
  );
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("storageClient", () => {
  it("is one client per process, kept on globalThis", () => {
    const client = storageClient();
    expect(storageClient()).toBe(client);
    expect((globalThis as { __nonaStorage?: unknown }).__nonaStorage).toBe(client);
  });
});

describe("createStorageClient", () => {
  it("makes two attempts in all, so a silent R2 can't hold a call for three request timeouts", async () => {
    const client = createStorageClient(storageConfig());
    expect(await client.config.maxAttempts()).toBe(2);
    client.destroy();
  });

  it("cuts off a request that gets no answer within 10 seconds", async () => {
    const client = createStorageClient({ ...storageConfig(), endpoint: `http://127.0.0.1:${port}` });
    // The client's own HTTP handler, so the SDK's retries don't multiply the wait.
    const handler = client.config.requestHandler as unknown as {
      handle(request: object): Promise<unknown>;
    };
    // performance.now() is monotonic: the wall clock can jump (WSL resyncs it) mid-test.
    const started = performance.now();
    try {
      await expect(
        handler.handle({
          protocol: "http:",
          hostname: "127.0.0.1",
          port,
          method: "GET",
          path: "/silent",
          query: {},
          headers: {},
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      client.destroy();
    }
    const seconds = (performance.now() - started) / 1000;
    expect(seconds).toBeGreaterThan(9);
    expect(seconds).toBeLessThan(13);
  }, 20_000);
});

describe("cutOffWhenIdle", () => {
  it("ends a download that stops sending with a timeout error", async () => {
    const stream = cutOffWhenIdle(await download("/stall"), 1000);
    await expect(readAll(stream)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("lets a slow but steady download finish", async () => {
    const stream = cutOffWhenIdle(await download("/steady"), 1000);
    expect(await readAll(stream)).toBe("chunk".repeat(8));
  });
});

describe("withDeadline", () => {
  it("gives a call the 15 s deadline when the caller passes no signal", () => {
    const { abortSignal } = withDeadline();
    expect(abortSignal.aborted).toBe(false);
  });

  it("Ruling K: combines the caller's signal with the deadline instead of replacing it", () => {
    const caller = new AbortController();
    const { abortSignal } = withDeadline({ signal: caller.signal });
    // A combined signal, not the caller's own: the caller's alone would drop the 15 s bound.
    expect(abortSignal).not.toBe(caller.signal);
    expect(abortSignal.aborted).toBe(false);
    caller.abort(new Error("the guest closed the page"));
    expect(abortSignal.aborted).toBe(true);
    expect((abortSignal.reason as Error).message).toBe("the guest closed the page");
  });

  it("ends at once when the caller's signal has already fired", () => {
    expect(withDeadline({ signal: AbortSignal.abort() }).abortSignal.aborted).toBe(true);
  });

  it("keeps the deadline at 15 s", () => {
    expect(CALL_DEADLINE_MILLISECONDS).toBe(15_000);
  });
});
