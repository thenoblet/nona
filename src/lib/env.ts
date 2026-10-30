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
