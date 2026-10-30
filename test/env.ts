// Settings for the local test database (docker compose up -d db).
export const TEST_DB_ENV = {
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "nona_test",
  POSTGRES_USER: "nona",
  POSTGRES_PASSWORD: "nona",
};
