/*
 * Save to Photos (gate B 1c): a phone opens its share menu only straight after a tap, and a video
 * takes longer than that to fetch, so it takes two taps. The first fetches the file (from the
 * presigned link, or the public bucket for a video's phone version), with its progress; the second
 * hands it to the share menu, where the guest picks Photos or Gallery.
 */

/** Fetches the file at `url` whole, saying how far it has got (a fraction, once its size is known). */
export async function fetchWhole(
  url: string,
  options: { signal: AbortSignal; onProgress: (fraction: number | null, totalBytes: number | null) => void },
): Promise<Blob> {
  const response = await fetch(url, { signal: options.signal, cache: "no-store" });
  if (!response.ok) throw new Error(`The file answered ${response.status}`);
  const total = Number(response.headers.get("content-length")) || null;
  options.onProgress(total ? 0 : null, total);
  if (!response.body) return response.blob();
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
    received += value.length;
    options.onProgress(total ? Math.min(1, received / total) : null, total);
  }
  return new Blob(chunks, { type: response.headers.get("content-type") ?? undefined });
}

export type ShareOutcome = "shared" | "dismissed" | "unsupported";

/** Hands the file to the phone's share menu: shared, dismissed by the guest, or not possible here. */
export async function shareFile(file: File): Promise<ShareOutcome> {
  try {
    if (!navigator.canShare?.({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError" ? "dismissed" : "unsupported";
  }
}

/** Saves the file the old way, as a download from the page itself (where sharing a file isn't possible). */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
