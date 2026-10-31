import { randomBytes } from "node:crypto";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";
import { createMediaQueues } from "@/lib/jobs/media-queues";

/*
 * Helpers for the upload API's tests, which run against the local MinIO and test database
 * (docker compose up -d db minio && npm run storage:init).
 */

/** A fingerprint as the phone makes it: sha-256 of the size and the first and last MB, in hex. */
export function newFingerprint(): string {
  return randomBytes(32).toString("hex");
}

/** A JSON request to one of the upload routes. */
export function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The route context Next passes a handler under /api/uploads/[id]. */
export function routeContext(mediaId: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: mediaId }) };
}

/** PUTs a part to its presigned URL, as the phone does (no headers but the bytes), and returns its ETag. */
export async function putPart(url: string, bytes: Uint8Array): Promise<string> {
  // A copy on an ArrayBuffer of its own, which fetch's body type asks for.
  const response = await fetch(url, { method: "PUT", body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PUT part failed with ${response.status}: ${await response.text()}`);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("PUT part returned no ETag");
  return etag;
}

/** Drops a pg-boss schema from the test database, so each run starts from nothing. */
export async function dropBossSchema(schema: string): Promise<void> {
  const sql = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`drop schema if exists ${sql(schema)} cascade`;
  } finally {
    await sql.end();
  }
}

/**
 * A real pg-boss on the test database in a schema of its own (so the e2e app's queue is
 * untouched), with the media queues created as the app creates them at start-up.
 */
export async function startTestBoss(schema: string): Promise<PgBoss> {
  await dropBossSchema(schema);
  const boss = new PgBoss({
    ...dbConfig(),
    schema,
    max: 2,
    connectionTimeoutMillis: 5000,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await createMediaQueues(boss);
  return boss;
}
