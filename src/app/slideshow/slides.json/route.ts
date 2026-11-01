import { connection } from "next/server";
import { describeError } from "@/lib/log-error";
import { loadSlides } from "../slides";

/** Never in a shared cache: a hidden moment must leave every screen on its next ask. */
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The slideshow's latest list. The open slideshow asks for it every 30 s, so new moments reach the
 * venue TV without a reload; when the album can't be read it answers 503, and the screen keeps what
 * it has and asks again sooner (src/components/slideshow/feed.ts).
 */
export async function GET() {
  // Outside the try: at request time only, and never a failure of the album's.
  await connection();
  try {
    const slides = await loadSlides();
    return Response.json({ slides }, { headers: NO_STORE });
  } catch (error) {
    console.error("[slideshow] could not read the album:", describeError(error));
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
