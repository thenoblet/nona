import { z } from "zod";

const keys = [
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
] as const;

// Not NodeJS.ProcessEnv: Next's typings make NODE_ENV required there.
type Env = Record<string, string | undefined>;

const schema = z.object({
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive(),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
});

// Name the first missing variable so a bad deploy is easy to diagnose.
export function dbConfig(env: Env = process.env) {
  for (const key of keys) {
    if (!env[key]) throw new Error(`Missing database setting: ${key}`);
  }
  const e = schema.parse(env);
  return {
    host: e.POSTGRES_HOST,
    port: e.POSTGRES_PORT,
    database: e.POSTGRES_DB,
    user: e.POSTGRES_USER,
    password: e.POSTGRES_PASSWORD,
  };
}

export function isDbConfigured(env: Env = process.env): boolean {
  return keys.every((key) => Boolean(env[key]));
}
