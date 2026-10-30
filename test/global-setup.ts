import { runMigrations } from "@/lib/db/migrate";

export default async function setup() {
  await runMigrations();
}
