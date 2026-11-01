import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { AdminAccessError, requireAdmin } from "@/lib/admin/access";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { describeError } from "@/lib/log-error";
import { downloadFilename, type AlbumCelebration } from "@/lib/media/album-item";
import { presignGet } from "@/lib/storage/objects";

type OriginalContext = { params: Promise<{ id: string }> };

// Guests' originals must never sit in a shared cache such as Cloudflare's.
const NO_STORE = "private, no-store";
/** How long the couple's link to an original lasts (Ruling BV). */
const ORIGINAL_LINK_SECONDS = 15 * 60;
const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE } });
}

/**
 * "Open original" (Ruling BV): a hidden or removed item's public files are deleted by design, so
 * the couple judge it from its original, through a 15-minute presigned link to the private bucket.
 * Behind Cloudflare Access with the rest of /admin, and checked here first all the same. An
 * album item or a wish's recording that finished uploading. It downloads, named as the album names
 * it, when it is a HEIC (a browser can't show it) or one the worker refused (failed: a file that
 * couldn't be read is the one not to open in the browser); anything else opens in the browser.
 * Nothing is ever re-published to the public bucket, and the link is never logged.
 */
export async function GET(_request: Request, { params }: OriginalContext) {
  // Request time only: a build without the Access settings must never prerender the refusal.
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) return textResponse(403, "This page is for the couple.");
    throw error;
  }
  const { id } = await params;
  if (!isUuid(id)) return textResponse(404, "Not found.");
  try {
    const [original] = await getDb()
      .select({
        originalKey: media.originalKey,
        contentType: media.contentType,
        kind: media.kind,
        celebration: media.celebration,
        status: media.status,
      })
      .from(media)
      .where(
        and(
          eq(media.id, id.toLowerCase()),
          inArray(media.purpose, ["album", "wish"]),
          isNull(media.deletedAt),
          isNotNull(media.uploadedAt),
        ),
      )
      .limit(1);
    if (!original) return textResponse(404, "Not found.");
    const heic = original.kind === "photo" && HEIC_TYPES.has(original.contentType);
    const download = heic || original.status === "failed";
    const extension = original.originalKey.split(".").pop() ?? "bin";
    // Presigning is local: no network call, so no timeout.
    const url = await presignGet(original.originalKey, {
      expiresInSeconds: ORIGINAL_LINK_SECONDS,
      filename: download ? downloadFilename(original.celebration as AlbumCelebration, id.toLowerCase(), extension) : undefined,
    });
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": NO_STORE, "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    // Ids only: never the link.
    console.error(`[admin] could not open media=${id}'s original:`, describeError(error));
    return textResponse(503, "That didn't work. Try again in a moment.");
  }
}
