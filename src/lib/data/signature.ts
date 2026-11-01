/*
 * A wish's signature, the same rule in the composer (checked before a recording is sent) and in the
 * server actions (checked again): shared here, small and free of any server module, so the client
 * bundle carries a few words and not the database's schema.
 */

/**
 * The longest a signature may be, in characters (code points, as Postgres counts them): the same as
 * a guest's name, NAME_MAX_CHARACTERS in the schema (signature.test.ts checks).
 */
export const SIGNATURE_MAX_CHARACTERS = 80;

export const SIGNATURE_WORDS = {
  missing: "Please sign your wish with your name.",
  tooLong: `Please keep your name under ${SIGNATURE_MAX_CHARACTERS} characters.`,
} as const;

/** What is wrong with a signature (already trimmed), in the guest's words, or null when it will do. */
export function signatureProblem(signedAs: string): string | null {
  if (!signedAs) return SIGNATURE_WORDS.missing;
  if ([...signedAs].length > SIGNATURE_MAX_CHARACTERS) return SIGNATURE_WORDS.tooLong;
  return null;
}
