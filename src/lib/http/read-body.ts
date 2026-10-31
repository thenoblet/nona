/**
 * The request's body as text, "" when there is none, or null when it is over `maxBytes`. It never
 * holds more than that in memory: a body that says it is too large isn't read at all, and a
 * streamed one is cut off as soon as it passes the limit.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
