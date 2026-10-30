/**
 * A log-safe description of an error: its name and database code only. Never the message or the
 * error itself, because query errors carry their parameters, which can include a guest's email.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const cause = error.cause as { code?: unknown } | undefined;
  const code = (error as { code?: unknown }).code ?? cause?.code;
  return typeof code === "string" ? `${error.name} (${code})` : error.name;
}
