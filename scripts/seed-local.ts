/**
 * Fills the local database and MinIO with sample rows, so the album and guestbook screens have
 * something to show while they are built:
 * - one sample guest;
 * - the couple's sample photos from public/images as that guest's album uploads;
 * - a few written wishes;
 * - uploads opened (a new database starts with them closed).
 *
 *   docker compose up -d db minio && npm run storage:init && npm run seed
 *
 * Each photo goes to the private bucket as an original, with its write-once metadata and its
 * manifest, and gets a media row marked uploaded: verified, and waiting for the media worker to
 * make its thumbnails. No job is queued for them: the worker's sweeper (`npm run worker`) queues
 * them, as it does any row uploaded over 5 minutes ago, when it starts and every 10 minutes after;
 * until then the album shows them to their own guest as "no preview yet".
 *
 * Running it again adds nothing new. It uses the POSTGRES_* and R2_* settings from the
 * environment, falling back to docker compose's for any that are unset, and refuses anything that
 * isn't on this machine. npm run seed runs it with --conditions=react-server, which lets the
 * server-only modules it shares with the app (the manifest's) load outside Next.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runMigrations } from "@/lib/db/migrate";
import { guests, media, settings, wishes } from "@/lib/db/schema";
import { dbConfig, storageConfig } from "@/lib/env";
import { storageClient, withDeadline } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { writeManifest } from "@/lib/storage/manifest";
import { encodeOriginalMetadata } from "@/lib/storage/metadata";

// docker compose's Postgres (the development database) and MinIO, with MinIO's well-known
// default keys (not secrets), as storage:init uses.
const LOCAL_SERVICES = {
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "nona",
  POSTGRES_USER: "nona",
  POSTGRES_PASSWORD: "nona",
  R2_ENDPOINT: "http://localhost:9000",
  R2_ACCESS_KEY_ID: "minioadmin",
  R2_SECRET_ACCESS_KEY: "minioadmin",
  R2_PRIVATE_BUCKET: "nona-private",
  R2_PUBLIC_BUCKET: "nona-public",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Fixed ids, so a second run finds the rows the first one made.
const SAMPLE_GUEST_ID = "5eed0000-0000-4000-8000-000000000001";
const SAMPLE_NAME = "[Sample guest]";

const SAMPLE_PHOTOS = [
  { id: "5eed0000-0000-4000-8000-000000000101", file: "story/nancy-smile.jpg", celebration: "reception" },
  { id: "5eed0000-0000-4000-8000-000000000102", file: "story/embrace-bw.jpg", celebration: "ceremony" },
  { id: "5eed0000-0000-4000-8000-000000000103", file: "flowers/chrysanthemums-portrait.jpg", celebration: "reception" },
  { id: "5eed0000-0000-4000-8000-000000000104", file: "story/bouquet.jpg", celebration: "thanks" },
  { id: "5eed0000-0000-4000-8000-000000000105", file: "story/kiss.jpg", celebration: "ceremony" },
  { id: "5eed0000-0000-4000-8000-000000000106", file: "flowers/daisies-wrapped.jpg", celebration: "reception" },
  { id: "5eed0000-0000-4000-8000-000000000107", file: "story/early-days.jpg", celebration: "more" },
  { id: "5eed0000-0000-4000-8000-000000000108", file: "story/how-we-met-bw.jpg", celebration: "thanks" },
  { id: "5eed0000-0000-4000-8000-000000000109", file: "flowers/chrysanthemums-wide.jpg", celebration: "ceremony" },
] as const;

const SAMPLE_WISHES = [
  {
    id: "5eed0000-0000-4000-8000-000000000201",
    message: "[May your home always be full of laughter, good food and the people who love you.]",
    createdAt: "2026-12-05T18:20:00Z",
  },
  {
    id: "5eed0000-0000-4000-8000-000000000202",
    message: "[We watched you go from classmates to forever. God bless this union.]",
    createdAt: "2026-12-05T18:00:00Z",
  },
  {
    id: "5eed0000-0000-4000-8000-000000000203",
    message:
      "[A longer wish from a guest. The wall keeps each one in their own words and signature, exactly as they left it on the night.]",
    createdAt: "2026-12-05T17:30:00Z",
  },
  { id: "5eed0000-0000-4000-8000-000000000204", message: "[Short and sweet.]", createdAt: "2026-12-05T17:00:00Z" },
];

/** Fills in docker compose's settings for any unset; false when a setting points off this machine. */
function applyLocalSettings(): boolean {
  for (const [name, localValue] of Object.entries(LOCAL_SERVICES)) {
    if (!process.env[name]) process.env[name] = localValue;
  }
  const databaseHost = process.env.POSTGRES_HOST ?? "";
  const storageHost = new URL(storageConfig().endpoint).hostname;
  return LOCAL_HOSTS.has(databaseHost) && LOCAL_HOSTS.has(storageHost);
}

async function seedGuest(db: PostgresJsDatabase): Promise<void> {
  const added = await db
    .insert(guests)
    // A personal-link token as createGuest makes one: 32 random bytes in base64url.
    .values({ id: SAMPLE_GUEST_ID, displayName: SAMPLE_NAME, linkToken: randomBytes(32).toString("base64url") })
    .onConflictDoNothing()
    .returning({ id: guests.id });
  console.log(added.length ? "guest: added" : "guest: already there");
}

async function seedPhotos(db: PostgresJsDatabase): Promise<void> {
  const { privateBucket } = storageConfig();
  for (const photo of SAMPLE_PHOTOS) {
    const [existing] = await db.select({ id: media.id }).from(media).where(eq(media.id, photo.id));
    if (existing) {
      console.log(`${photo.file}: already there`);
      continue;
    }
    const bytes = await readFile(join(process.cwd(), "public", "images", photo.file));
    const key = originalKey(photo.id, "jpg");
    const originalFilename = photo.file.split("/").pop() ?? photo.file;
    const startedAt = new Date();

    // The original and its manifest first, so a row never points at a missing original.
    await storageClient().send(
      new PutObjectCommand({
        Bucket: privateBucket,
        Key: key,
        Body: bytes,
        ContentType: "image/jpeg",
        Metadata: encodeOriginalMetadata({
          guestId: SAMPLE_GUEST_ID,
          uploaderName: SAMPLE_NAME,
          originalFilename,
          startedAt,
        }),
      }),
      withDeadline(),
    );
    await writeManifest(photo.id, {
      celebration: photo.celebration,
      celebrationSetByAdmin: false,
      hiddenAt: null,
      hiddenBy: null,
      removedByUploader: false,
      deletedAt: null,
    });
    await db.insert(media).values({
      id: photo.id,
      purpose: "album",
      kind: "photo",
      guestId: SAMPLE_GUEST_ID,
      uploaderName: SAMPLE_NAME,
      celebration: photo.celebration,
      originalKey: key,
      originalFilename,
      sizeBytes: bytes.byteLength,
      contentType: "image/jpeg",
      startedAt,
      uploadedAt: new Date(),
      status: "uploaded",
    });
    console.log(`${photo.file}: added as ${key}`);
  }
}

async function seedWishes(db: PostgresJsDatabase): Promise<void> {
  const added = await db
    .insert(wishes)
    .values(
      SAMPLE_WISHES.map((wish) => ({
        id: wish.id,
        kind: "text" as const,
        message: wish.message,
        signedAs: "[Guest's name]",
        createdAt: new Date(wish.createdAt),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: wishes.id });
  console.log(`wishes: ${added.length} added`);
}

/** Opens uploads, as the couple will from the admin; a new database starts with them closed. */
async function openUploads(db: PostgresJsDatabase): Promise<void> {
  const open = sql`'true'::jsonb`;
  await db
    .insert(settings)
    .values({ key: "uploads_open", value: open })
    .onConflictDoUpdate({ target: settings.key, set: { value: open, updatedAt: sql`now()` } });
  console.log("uploads: open");
}

async function main() {
  if (!applyLocalSettings()) {
    console.error("seed fills the local database and MinIO only; POSTGRES_HOST and R2_ENDPOINT must be on this machine.");
    process.exitCode = 1;
    return;
  }
  // Its own connection, bounded as the app's are, closed at the end so the script exits.
  const connection = postgres({
    ...dbConfig(),
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 10_000 },
  });
  try {
    await runMigrations();
    const db = drizzle(connection);
    await seedGuest(db);
    await seedPhotos(db);
    await seedWishes(db);
    await openUploads(db);
  } finally {
    await connection.end();
    storageClient().destroy();
  }
}

main().catch((error: unknown) => {
  console.error("seed failed:", error instanceof Error ? error.message : error);
  console.error("Are Postgres and MinIO running? docker compose up -d db minio && npm run storage:init");
  process.exit(1);
});
