import { connection } from "next/server";
import { findGuestByToken } from "@/lib/data/guests";
import type { Guest } from "@/lib/data/types";
import { adoptGuest, ensureOwnGuest, ownGuestId, rememberGuest } from "@/lib/guests/cookie";
import { rateLimitedResponse, takeToken } from "@/lib/guests/rate-limit";
import { readBodyText } from "@/lib/http/read-body";
import { describeError } from "@/lib/log-error";

// Never in a shared cache such as Cloudflare's: these responses set or depend on the browser's cookie.
const NO_STORE = "private, no-store";

// The confirm page's form is a single short field.
const MAX_FORM_BYTES = 1024;

type LinkContext = { params: Promise<{ token: string }> };

// A relative Location: the browser resolves it against the address it opened, so it works behind
// Cloudflare and the proxy, and on any local port, without knowing the site's address.
function redirectTo(location: string, status: 302 | 303 = 302): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": NO_STORE } });
}

function plainText(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

/** The 429 when the browser has a guest and has opened links too quickly; null when it may go on. */
function linkLimit(ownId: string | null): Response | null {
  if (!ownId) return null;
  const { allowed, retryAfterSeconds } = takeToken(ownId, "link");
  return allowed ? null : rateLimitedResponse(retryAfterSeconds);
}

/** The guest the token belongs to, null for none, or undefined when the database couldn't answer. */
async function linkedGuest(token: string): Promise<Guest | null | undefined> {
  try {
    return await findGuestByToken(token);
  } catch (error) {
    // The error's name and code only: a query error carries its parameters, here the token.
    console.error("[my] could not look up a personal link:", describeError(error));
    return undefined;
  }
}

const unavailable = () => plainText(503, "Your link didn't open. Please try again in a moment.");

/**
 * Whether a POST came from a page of this site: the browser says so (Sec-Fetch-Site), and its
 * Origin names this host (behind the proxy, the host it forwarded). A browser always sends Origin
 * with a form POST, so a missing one is refused too. Another site can't make a browser choose.
 */
function postedFromThisSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Includes Origin: null, sent from sandboxed frames and some redirects.
    return false;
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
  const requestHost = forwardedHost || request.headers.get("host") || new URL(request.url).host;
  return originHost === requestHost.toLowerCase();
}

/**
 * A guest's personal link. Opening it never changes the cookie.
 * - A browser whose own guest is the linked one opens "My uploads".
 * - Any other browser is asked first, on /my/<token>/confirm: one without a guest, since a link
 *   shared in a group chat must not make everyone who taps it that guest (Ruling S), and one with
 *   its own guest, since "Yes" now makes the link its own from then on (Ruling CG). (A route
 *   handler can't render the site's pages, and this one must stay a route handler to set the
 *   cookie in POST, so the question is a page of its own.)
 * - An unknown or malformed token opens the album and changes nothing.
 * Limited per browser by its own guest (20, then 1 a second), never by IP; a browser without a
 * guest has nothing to key on and isn't limited, as the token is the secret.
 */
export async function GET(_request: Request, { params }: LinkContext) {
  // Request time only: the build never touches the database.
  await connection();
  const { token } = await params;

  const ownId = await ownGuestId();
  const limited = linkLimit(ownId);
  if (limited) return limited;

  const guest = await linkedGuest(token);
  if (guest === undefined) return unavailable();
  if (!guest) return redirectTo("/album");
  if (ownId === guest.id) return redirectTo("/album?view=mine");
  return redirectTo(`/my/${guest.linkToken}/confirm`);
}

/**
 * The confirm page's answer, `choice=yes` or `choice=no`, posted from this site only (403 otherwise,
 * changing nothing).
 * - "Yes, that's me": the linked guest becomes this browser's own from now on, so what it shares
 *   goes with the link; a guest it had before is remembered first, its uploads still in "My
 *   uploads" (Ruling CG).
 * - "No, I'm someone else": the browser keeps its own guest (or gets a new one), with the linked one
 *   remembered beside it.
 * Both then open "My uploads".
 */
export async function POST(request: Request, { params }: LinkContext) {
  if (!postedFromThisSite(request)) return plainText(403, "Please choose on your link's own page.");
  const { token } = await params;

  const limited = linkLimit(await ownGuestId());
  if (limited) return limited;

  const body = await readBodyText(request, MAX_FORM_BYTES);
  if (body === null) return plainText(413, "The request is too large.");
  const choice = new URLSearchParams(body).get("choice");
  if (choice !== "yes" && choice !== "no") return plainText(400, "Please choose one of the two answers.");

  const guest = await linkedGuest(token);
  if (guest === undefined) return unavailable();
  if (!guest) return redirectTo("/album", 303);

  if (choice === "yes") {
    await adoptGuest(guest.id);
    return redirectTo("/album?view=mine", 303);
  }
  try {
    await ensureOwnGuest(null);
  } catch (error) {
    console.error("[my] could not make the browser's own guest:", describeError(error));
    return unavailable();
  }
  await rememberGuest(guest.id);
  return redirectTo("/album?view=mine", 303);
}
