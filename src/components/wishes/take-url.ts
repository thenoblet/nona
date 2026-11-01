/*
 * An object URL for a recording on the phone (to listen to or watch it back), made once per file and
 * let go once nothing shows it: held by the components that show it, revoked a moment after the last
 * lets go, so React's development double-mount (which lets go and holds again at once) never revokes
 * a URL still in use.
 */

type Entry = { url: string; holders: number; revokeTimer: ReturnType<typeof setTimeout> | null };

const entries = new WeakMap<Blob, Entry>();

/** How long a URL nothing holds lives on, in case something holds it again at once. */
const REVOKE_AFTER_MILLISECONDS = 1_000;

function entryOf(file: Blob): Entry {
  let entry = entries.get(file);
  if (!entry) {
    entry = { url: URL.createObjectURL(file), holders: 0, revokeTimer: null };
    entries.set(file, entry);
  }
  return entry;
}

/** The file's object URL, the same one each time while it is held. */
export function takeUrlOf(file: Blob): string {
  return entryOf(file).url;
}

/** Holds the file's URL while something shows it; returns what lets it go. */
export function holdTakeUrl(file: Blob): () => void {
  const entry = entryOf(file);
  entry.holders += 1;
  if (entry.revokeTimer !== null) clearTimeout(entry.revokeTimer);
  entry.revokeTimer = null;
  return () => {
    entry.holders -= 1;
    if (entry.holders > 0) return;
    entry.revokeTimer = setTimeout(() => {
      URL.revokeObjectURL(entry.url);
      entries.delete(file);
    }, REVOKE_AFTER_MILLISECONDS);
  };
}
