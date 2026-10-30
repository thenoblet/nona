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

/**
 * An error's name and message, only for errors that cannot carry guest details: the job queue's
 * own, whose jobs hold nothing but a reply id. Anything that touched a reply uses describeError.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "unknown error";
}
