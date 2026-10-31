const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the text is a UUID, as every row id is. Ids arrive from URLs and cookies, and Postgres
 * throws on a malformed uuid, so callers check first and treat anything else as "not found".
 */
export function isUuid(text: string): boolean {
  return UUID.test(text);
}
