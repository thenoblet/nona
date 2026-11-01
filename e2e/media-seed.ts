import { randomBytes, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import sharp from "sharp";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "../test/env";

/*
 * Ready album moments for the slideshow's and the home page's checks, seeded straight into the test
 * database with their viewing size and thumbnail in MinIO, as the media worker leaves them.
 */

/** The test database, for a spec's own seeding and checks. Call end() in its afterAll. */
export function testSql() {
  return postgres({
    host: TEST_DB_ENV.POSTGRES_HOST,
    port: Number(TEST_DB_ENV.POSTGRES_PORT),
    database: TEST_DB_ENV.POSTGRES_DB,
    user: TEST_DB_ENV.POSTGRES_USER,
    password: TEST_DB_ENV.POSTGRES_PASSWORD,
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
}

let storage: S3Client | null = null;

/** MinIO, made when first used, so a spec that closed it can use it again. */
function storageClient(): S3Client {
  storage ??= new S3Client({
    endpoint: TEST_STORAGE_ENV.R2_ENDPOINT,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: TEST_STORAGE_ENV.R2_ACCESS_KEY_ID, secretAccessKey: TEST_STORAGE_ENV.R2_SECRET_ACCESS_KEY },
  });
  return storage;
}

const PALETTE = ["#c9a27e", "#7b3a2c", "#d3d9c8", "#2a1b1f", "#efe5d8", "#c96a3a", "#9aa68b", "#6a4a3e"];

async function putPublic(key: string, body: Buffer): Promise<void> {
  await storageClient().send(new PutObjectCommand({ Bucket: TEST_STORAGE_ENV.R2_PUBLIC_BUCKET, Key: key, Body: body, ContentType: "image/webp" }));
}

export type SeededMoment = { id: string; view: string };

/**
 * A ready album moment listed `secondsAgo` before now: a photo, or a video by its poster, with its
 * viewing size and thumbnail in MinIO. Its original is never read here, so none is stored.
 */
export async function seedMoment(
  sql: ReturnType<typeof testSql>,
  options: {
    index: number;
    secondsAgo: number;
    uploaderName?: string | null;
    kind?: "photo" | "video";
    celebration?: string;
    guestId?: string | null;
  },
): Promise<SeededMoment> {
  const id = randomUUID();
  const kind = options.kind ?? "photo";
  const [width, height] = kind === "video" ? [720, 1280] : options.index % 2 === 0 ? [1200, 900] : [900, 1200];
  const colour = PALETTE[options.index % PALETTE.length];
  const hash = randomBytes(8).toString("hex");
  const prefix = kind === "video" ? "poster-" : "";
  const derived = {
    [`${prefix}thumb`]: `derived/${id}/${hash}/${prefix}thumb.webp`,
    [`${prefix}view`]: `derived/${id}/${hash}/${prefix}view.webp`,
  };
  const picture = sharp({ create: { width, height, channels: 3, background: colour } });
  await putPublic(derived[`${prefix}view`], await picture.clone().webp({ quality: 60 }).toBuffer());
  await putPublic(derived[`${prefix}thumb`], await picture.clone().resize(Math.round(width / 3)).webp({ quality: 60 }).toBuffer());
  const listed = new Date(Date.now() - options.secondsAgo * 1000);
  await sql`
    insert into media (id, purpose, kind, guest_id, uploader_name, celebration, original_key, original_filename, size_bytes,
      content_type, status, uploaded_at, listed_at, derived, width, height, thumbhash, average_color)
    values (${id}, 'album', ${kind}, ${options.guestId ?? null}, ${options.uploaderName === undefined ? "Kwame" : options.uploaderName},
      ${options.celebration ?? "reception"}, ${`originals/${id}.${kind === "video" ? "mov" : "jpg"}`}, 'IMG_0001.JPG', 2048,
      ${kind === "video" ? "video/quicktime" : "image/jpeg"}, 'ready', ${listed}, ${listed}, ${sql.json(derived)}, ${width}, ${height},
      '1QcSHQRnh493V4dIh4eXh1h4kJUI', ${colour})`;
  return { id, view: `${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${derived[`${prefix}view`]}` };
}

/** Lets MinIO's connections go, for a spec's afterAll. */
export function closeStorage(): void {
  storage?.destroy();
  storage = null;
}
