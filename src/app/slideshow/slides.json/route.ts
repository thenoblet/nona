import { loadSlides } from "../slides";

/**
 * The slideshow's latest list. The open slideshow asks for it every 30 s, so new moments
 * reach the venue TV without a reload, and a failed request leaves the screen as it was.
 */
export async function GET() {
  const slides = await loadSlides();
  return Response.json({ slides }, { headers: { "Cache-Control": "no-store" } });
}
