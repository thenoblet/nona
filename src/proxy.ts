import { NextResponse, type NextRequest } from "next/server";

/**
 * Every optimized photo comes back as WebP, whatever the client asked for.
 * The optimizer picks the format from the Accept header, but Cloudflare keeps one
 * copy per URL and ignores Vary: Accept, so the first client to fetch a size (a
 * crawler asking for anything) would otherwise decide the format for everyone.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("accept", "image/webp,*/*");
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: "/_next/image",
};
