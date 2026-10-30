import { connection } from "next/server";
import { findGuestByToken } from "@/lib/data/guests";
import { ownGuestId, rememberGuest } from "@/lib/guests/cookie";
import { rateLimitedResponse, takeToken } from "@/lib/guests/rate-limit";
import { describeError } from "@/lib/log-error";

// Never in a shared cache such as Cloudflare's: the response sets this browser's cookie.
const NO_STORE = "private, no-store";

// A relative Location: the browser resolves it against the address it opened, so it works behind
// Cloudflare and the proxy, and on any local port, without knowing the site's address.
function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": NO_STORE } });
}

/**
 * A guest's personal link. Opening it remembers that guest in this browser's cookie (as the
 * browser's own when it has none) and opens "My uploads"; an unknown or malformed token opens the
 * album and changes nothing. Limited per browser by its own guest (20, then 1 a second), never by
 * IP; a browser without a guest has nothing to key on and isn't limited, as the token is the secret.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  // Request time only: the build never touches the database.
  await connection();
  const { token } = await params;

  const ownId = await ownGuestId();
  if (ownId) {
    const { allowed, retryAfterSeconds } = takeToken(ownId, "link");
    if (!allowed) return rateLimitedResponse(retryAfterSeconds);
  }

  let guest;
  try {
    guest = await findGuestByToken(token);
  } catch (error) {
    // The error's name and code only: a query error carries its parameters, here the token.
    console.error("[my] could not look up a personal link:", describeError(error));
    return new Response("Your link didn't open. Please try again in a moment.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE },
    });
  }
  if (!guest) return redirectTo("/album");

  await rememberGuest(guest.id);
  return redirectTo("/album?view=mine");
}
