// Settings for the local test database (docker compose up -d db).
export const TEST_DB_ENV = {
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "nona_test",
  POSTGRES_USER: "nona",
  POSTGRES_PASSWORD: "nona",
};

// Settings for the local MinIO standing in for R2 (docker compose up -d minio, then
// npm run storage:init). The keys are MinIO's well-known defaults, not secrets.
export const TEST_STORAGE_ENV = {
  R2_ENDPOINT: "http://localhost:9000",
  R2_ACCESS_KEY_ID: "minioadmin",
  R2_SECRET_ACCESS_KEY: "minioadmin",
  R2_PRIVATE_BUCKET: "nona-private",
  R2_PUBLIC_BUCKET: "nona-public",
  MEDIA_BASE_URL: "http://localhost:9000/nona-public",
};
