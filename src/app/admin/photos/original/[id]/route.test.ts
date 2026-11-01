import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageConfig } from "@/lib/env";
import { storageClient } from "@/lib/storage/client";
import { addAlbumItem } from "../../../../../../test/album";
import { resetDb } from "../../../../../../test/db";
import { routeContext } from "../../../../../../test/uploads";

// Against the test database and the local MinIO: docker compose up -d db minio && npm run storage:init.

vi.mock("next/server", () => ({ connection: async () => {} }));

const admin = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/admin/access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/admin/access")>();
  return {
    ...real,
    requireAdmin: async () => {
      if (!admin.allowed) throw new real.AdminAccessError();
      return { email: "couple@example.com" };
    },
  };
});

import { GET } from "./route";

const LOG_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** Everything the route wrote to the console, as one text. */
function watchLogs(): () => string {
  const spies = LOG_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  return () => spies.flatMap((spy) => spy.mock.calls.flat().map((part) => (part instanceof Error ? `${part.message} ${part.stack}` : String(part)))).join("\n");
}

function request(mediaId: string): Request {
  return new Request(`https://example.com/admin/photos/original/${mediaId}`);
}

async function putOriginal(key: string, body: Buffer, contentType: string): Promise<void> {
  await storageClient().send(
    new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: body, ContentType: contentType }),
    { abortSignal: AbortSignal.timeout(10_000) },
  );
}

beforeEach(async () => {
  await resetDb();
  admin.allowed = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /admin/photos/original/[id]", () => {
  it("refuses anyone but the couple, uncached, naming nothing", async () => {
    const mediaId = await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    const logs = watchLogs();
    const response = await GET(request(mediaId), routeContext(mediaId));
    expect(response.status).toBe(403);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).toBe("This page is for the couple.");
    expect(logs()).not.toContain("X-Amz");
  });

  it("sends the couple to a 15-minute link to a hidden item's original, which opens in the browser, and never logs it", async () => {
    const mediaId = randomUUID();
    const key = `originals/${mediaId}.jpg`;
    const bytes = Buffer.from("not really a jpeg, but the original's own bytes");
    await putOriginal(key, bytes, "image/jpeg");
    await addAlbumItem({ id: mediaId, originalKey: key, hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    admin.allowed = true;
    const logs = watchLogs();

    const response = await GET(request(mediaId), routeContext(mediaId));
    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe(`/${storageConfig().privateBucket}/${key}`);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(location.searchParams.get("response-content-disposition")).toBeNull();

    const original = await fetch(location, { signal: AbortSignal.timeout(10_000) });
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);

    const logged = logs();
    expect(logged).not.toContain(location.toString());
    expect(logged).not.toContain("X-Amz-Signature");
  });

  it("downloads an iPhone's HEIC, which a browser can't show, named as the album names it", async () => {
    const mediaId = randomUUID();
    await addAlbumItem({
      id: mediaId,
      celebration: "reception",
      originalKey: `originals/${mediaId}.heic`,
      contentType: "image/heic",
      hiddenAt: new Date(),
      hiddenBy: "guest",
      removedByUploader: true,
    });
    admin.allowed = true;
    const response = await GET(request(mediaId), routeContext(mediaId));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      new RegExp(`^attachment; filename="NONA26-reception-${mediaId.slice(0, 8)}\\.heic"`),
    );
  });

  it("answers 404 for an id that isn't one, an item that isn't there, a tombstone, or an upload not finished", async () => {
    admin.allowed = true;
    const deleted = await addAlbumItem({ deletedAt: new Date() });
    const uploading = await addAlbumItem({ status: "uploading", uploadedAt: null });
    for (const id of ["not-an-id", randomUUID(), deleted, uploading]) {
      const response = await GET(request(id), routeContext(id));
      expect(response.status, id).toBe(404);
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("opens a wish's recording too, for the Wishes tab", async () => {
    admin.allowed = true;
    const recording = await addAlbumItem({ purpose: "wish", kind: "audio", originalKey: `originals/${randomUUID()}.m4a`, contentType: "audio/mp4" });
    const response = await GET(request(recording), routeContext(recording));
    expect(response.status).toBe(302);
  });
});
