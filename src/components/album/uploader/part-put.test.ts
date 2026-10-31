import { describe, expect, it } from "vitest";
import { createPartPut, type PartRequest } from "./part-put";

/** A stand-in XMLHttpRequest the test answers by hand. */
class FakeRequest implements PartRequest {
  status = 0;
  responseText = "";
  responseType: XMLHttpRequestResponseType = "";
  headers: Record<string, string> = {};
  sentHeaders: Record<string, string> = {};
  opened: { method: string; url: string } | null = null;
  sent: Blob | FormData | null = null;
  aborted = false;
  readonly #listeners = new Map<string, (() => void)[]>();
  readonly #progress: ((event: ProgressEvent) => void)[] = [];
  readonly upload = {
    addEventListener: (_type: "progress", listener: (event: ProgressEvent) => void) => {
      this.#progress.push(listener);
    },
  };

  open(method: string, url: string) {
    this.opened = { method, url };
  }
  setRequestHeader(name: string, value: string) {
    this.sentHeaders[name] = value;
  }
  send(body: Blob | FormData) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.#emit("abort");
  }
  getResponseHeader(name: string) {
    return this.headers[name.toLowerCase()] ?? null;
  }
  addEventListener(type: "load" | "error" | "abort", listener: () => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  #emit(type: string) {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }

  /** The browser sent this much of the body. */
  sendProgress(loaded: number, total: number) {
    for (const listener of this.#progress) listener({ loaded, total, lengthComputable: true } as ProgressEvent);
  }
  respond(status: number, headers: Record<string, string> = {}, text = "") {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    this.responseText = text;
    this.#emit("load");
  }
  dropConnection() {
    this.#emit("error");
  }
}

function harness(stallMs = 60_000) {
  const requests: FakeRequest[] = [];
  const put = createPartPut({
    stallMs,
    createRequest: () => {
      const request = new FakeRequest();
      requests.push(request);
      return request;
    },
  });
  return { put, requests };
}

const body = new Blob([new Uint8Array(1000)]);

describe("a part's PUT", () => {
  it("sends the bytes as a plain PUT to the signed link, with no headers", async () => {
    const { put, requests } = harness();
    const done = put({ signature: { url: "https://r2.example/part-1?sig" }, body });
    requests[0].respond(200, { ETag: '"abc"' });

    expect(await done).toEqual({ ETag: '"abc"' });
    expect(requests[0].opened).toEqual({ method: "PUT", url: "https://r2.example/part-1?sig" });
    expect(requests[0].sentHeaders).toEqual({});
    expect(requests[0].sent).toBe(body);
  });

  it("resolves a 2xx whose ETag the browser can't read, with an empty one, rather than hanging", async () => {
    const { put, requests } = harness();
    const completed: string[] = [];
    const progress: number[] = [];
    const done = put({
      signature: { url: "u" },
      body,
      onComplete: (etag) => completed.push(etag),
      onProgress: (event) => progress.push(event.loaded),
    });
    requests[0].sendProgress(400, 1000);
    requests[0].respond(200);

    expect(await done).toEqual({ ETag: "" });
    expect(completed).toEqual([""]);
    expect(progress).toEqual([400, 1000]);
  });

  it("rejects an answer outside 2xx with its status, and an expired link's 403 so Uppy signs it again", async () => {
    const { put, requests } = harness();
    const failed = put({ signature: { url: "u" }, body });
    requests[0].respond(500);
    await expect(failed).rejects.toMatchObject({ message: "Non 2xx", source: { status: 500 } });

    const expired = put({ signature: { url: "u" }, body });
    requests[1].respond(403, {}, "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>");
    await expect(expired).rejects.toMatchObject({ message: "Request has expired", source: { status: 403 } });
  });

  it("rejects a dropped connection with status 0, which Uppy retries", async () => {
    const { put, requests } = harness();
    const dropped = put({ signature: { url: "u" }, body });
    requests[0].dropConnection();

    await expect(dropped).rejects.toMatchObject({ source: { status: 0 } });
  });

  it("drops a part with no progress for its stall time, as a dropped connection, and keeps waiting while bytes move", async () => {
    const { put, requests } = harness(40);
    const moving = put({ signature: { url: "u" }, body });
    // Progress every 20 ms keeps it alive past 40 ms.
    for (let tick = 1; tick <= 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      requests[0].sendProgress(tick * 200, 1000);
    }
    requests[0].respond(200, { ETag: "e" });
    expect(await moving).toEqual({ ETag: "e" });

    const stalled = put({ signature: { url: "u" }, body });
    await expect(stalled).rejects.toMatchObject({ message: "The part stalled", stalled: true, source: { status: 0 } });
    expect(requests[1].aborted).toBe(true);
  });

  it("stops when the caller aborts, as an AbortError carrying the reason (Uppy's pause tells itself apart by it)", async () => {
    const { put, requests } = harness();
    const controller = new AbortController();
    const pausing = Symbol("pausing");
    const stopped = put({ signature: { url: "u" }, body, signal: controller.signal });
    controller.abort(pausing);

    await expect(stopped).rejects.toMatchObject({ name: "AbortError", cause: pausing });
    expect(requests[0].aborted).toBe(true);
    // Already aborted: no request at all.
    await expect(put({ signature: { url: "u" }, body, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  });
});
