/**
 * Sets up the local MinIO that stands in for R2: creates the private and public buckets if they
 * are missing and lets anyone read the public one, as R2 serves it on the media domain.
 *
 *   docker compose up -d minio && npm run storage:init
 *
 * It waits up to 30 s for a MinIO that is still starting. It uses the R2_* settings from the
 * environment, falling back to docker compose's MinIO for any that are unset. It refuses R2 itself:
 * there, the buckets, CORS and public domain are made in Cloudflare.
 */
import { CreateBucketCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import { storageConfig } from "@/lib/env";
import { createStorageClient, withDeadline } from "@/lib/storage/client";

// docker compose's MinIO, with MinIO's well-known default keys (not secrets).
const LOCAL_MINIO = {
  R2_ENDPOINT: "http://localhost:9000",
  R2_ACCESS_KEY_ID: "minioadmin",
  R2_SECRET_ACCESS_KEY: "minioadmin",
  R2_PRIVATE_BUCKET: "nona-private",
  R2_PUBLIC_BUCKET: "nona-public",
};

function settingsWithLocalFallback(): Record<string, string | undefined> {
  const settings: Record<string, string | undefined> = { ...process.env };
  for (const [name, localValue] of Object.entries(LOCAL_MINIO)) {
    if (!settings[name]) settings[name] = localValue;
  }
  return settings;
}

/** Waits for MinIO's liveness check to answer 200, as it does once MinIO is serving requests. */
async function waitForMinio(endpoint: string): Promise<void> {
  const started = performance.now();
  for (;;) {
    try {
      const response = await fetch(new URL("/minio/health/live", endpoint), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (performance.now() - started > 30_000) {
      throw new Error(`MinIO at ${endpoint} wasn't ready after 30 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function createBucketIfMissing(client: ReturnType<typeof createStorageClient>, bucket: string) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }), withDeadline());
    console.log(`${bucket}: created`);
  } catch (error) {
    if (error instanceof Error && error.name === "BucketAlreadyOwnedByYou") {
      console.log(`${bucket}: already there`);
      return;
    }
    throw error;
  }
}

async function main() {
  const config = storageConfig(settingsWithLocalFallback());
  if (new URL(config.endpoint).hostname.endsWith(".r2.cloudflarestorage.com")) {
    console.error("storage:init sets up the local MinIO only; R2's buckets are made in Cloudflare.");
    process.exitCode = 1;
    return;
  }

  const client = createStorageClient(config);
  try {
    await waitForMinio(config.endpoint);
    await createBucketIfMissing(client, config.privateBucket);
    await createBucketIfMissing(client, config.publicBucket);
    const anyoneMayRead = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: ["*"] },
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${config.publicBucket}/*`],
        },
      ],
    };
    await client.send(
      new PutBucketPolicyCommand({ Bucket: config.publicBucket, Policy: JSON.stringify(anyoneMayRead) }),
      withDeadline(),
    );
    console.log(`${config.publicBucket}: anyone can read its objects`);
  } catch (error) {
    console.error(`Is MinIO running at ${config.endpoint}? docker compose up -d minio`);
    throw error;
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error("storage:init failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
