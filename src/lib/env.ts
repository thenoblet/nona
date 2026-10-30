import * as zod from "zod";

const keys = [
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
] as const;

// Not NodeJS.ProcessEnv: Next's typings make NODE_ENV required there.
type Env = Record<string, string | undefined>;

const schema = zod.object({
  POSTGRES_HOST: zod.string().min(1),
  POSTGRES_PORT: zod.coerce.number().int().positive(),
  POSTGRES_DB: zod.string().min(1),
  POSTGRES_USER: zod.string().min(1),
  POSTGRES_PASSWORD: zod.string().min(1),
});

// Name the first missing variable so a bad deploy is easy to diagnose.
export function dbConfig(env: Env = process.env) {
  for (const key of keys) {
    if (!env[key]) throw new Error(`Missing database setting: ${key}`);
  }
  const settings = schema.parse(env);
  return {
    host: settings.POSTGRES_HOST,
    port: settings.POSTGRES_PORT,
    database: settings.POSTGRES_DB,
    user: settings.POSTGRES_USER,
    password: settings.POSTGRES_PASSWORD,
  };
}

export function isDbConfigured(env: Env = process.env): boolean {
  return keys.every((key) => Boolean(env[key]));
}

const storageKeys = [
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PRIVATE_BUCKET",
  "R2_PUBLIC_BUCKET",
] as const;

const httpAddress = zod.url({ protocol: /^https?$/ });

const storageSchema = zod.object({
  R2_ENDPOINT: httpAddress,
  R2_ACCESS_KEY_ID: zod.string().min(1),
  R2_SECRET_ACCESS_KEY: zod.string().min(1),
  R2_PRIVATE_BUCKET: zod.string().min(1),
  R2_PUBLIC_BUCKET: zod.string().min(1),
});

export type StorageConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  privateBucket: string;
  publicBucket: string;
};

/**
 * R2, through its S3 API: the private bucket holds originals and manifests, the public one the
 * derived files. Locally, MinIO stands in. Names the first missing variable, as dbConfig does.
 */
export function storageConfig(env: Env = process.env): StorageConfig {
  for (const key of storageKeys) {
    if (!env[key]) throw new Error(`Missing storage setting: ${key}`);
  }
  const settings = storageSchema.parse(env);
  return {
    endpoint: settings.R2_ENDPOINT,
    accessKeyId: settings.R2_ACCESS_KEY_ID,
    secretAccessKey: settings.R2_SECRET_ACCESS_KEY,
    privateBucket: settings.R2_PRIVATE_BUCKET,
    publicBucket: settings.R2_PUBLIC_BUCKET,
  };
}

/** Where the public bucket is served (media.<site> in production), without a trailing slash. */
export function mediaBaseUrl(env: Env = process.env): string {
  if (!env.MEDIA_BASE_URL) throw new Error("Missing storage setting: MEDIA_BASE_URL");
  const settings = zod.object({ MEDIA_BASE_URL: httpAddress }).parse(env);
  return settings.MEDIA_BASE_URL.replace(/\/+$/, "");
}
