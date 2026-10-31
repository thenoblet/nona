import { describe, expect, it } from "vitest";
import { readBodyText } from "./read-body";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function postWith(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/", { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

describe("readBodyText", () => {
  it("reads a small body as text, and no body as empty", async () => {
    expect(await readBodyText(postWith("choice=yes"), 64)).toBe("choice=yes");
    expect(await readBodyText(postWith("Ɔkɔm"), 64)).toBe("Ɔkɔm");
    expect(await readBodyText(postWith(null), 64)).toBe("");
  });

  it("reads exactly the limit, and refuses one byte more", async () => {
    expect(await readBodyText(postWith("a".repeat(64)), 64)).toBe("a".repeat(64));
    expect(await readBodyText(postWith("a".repeat(65)), 64)).toBeNull();
  });

  it("refuses a body that says it is too large without reading it", async () => {
    expect(await readBodyText(postWith("{}", { "Content-Length": "5000000" }), 64)).toBeNull();
  });

  it("stops reading a streamed body once it passes the limit", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1_000));
      },
    });
    expect(await readBodyText(postWith(endless), 4_096)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await readBodyText(postWith(streamOf(["choice", "=", "no"])), 64)).toBe("choice=no");
  });
});
