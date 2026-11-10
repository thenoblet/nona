import type { Metadata } from "next";
import { accraDayAndFullMonth } from "@/lib/accra";
import { getSiteContent } from "@/lib/content/get";
import { getSiteImages, storedCardImages } from "@/lib/site-images/get";
import { shareDefaults } from "@/lib/share";

/**
 * The invitation's link preview, read at request time: the reply-by date set in the admin, or
 * replies being closed, and the card the worker drew once the couple changed its photo (Site photos,
 * "Home, and any page without its own"); until then, app/opengraph-image.tsx's build-time card.
 *
 * The root layout gives it to every page without its own, and the landing page gives it again:
 * Next applies app/opengraph-image.tsx to the page beside it unless that page's own metadata names
 * `images`, so without its own copy `/` kept the build-time card after the couple replaced it.
 */
export async function invitationOpenGraph(): Promise<NonNullable<Metadata["openGraph"]>> {
  const [{ rsvp }, siteImages] = await Promise.all([getSiteContent(), getSiteImages()]);
  return {
    ...shareDefaults,
    title: "Noblet & Nancy · 5 December 2026",
    description: `Together with their families, they invite you to celebrate the beginning of their forever. Tepa, Ashanti. ${
      rsvp.open ? `Kindly reply by ${accraDayAndFullMonth(rsvp.replyBy)}.` : "Replies have closed."
    }`,
    url: "/",
    ...storedCardImages(siteImages, "invitation"),
  };
}
