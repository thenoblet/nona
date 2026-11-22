import type { FinalHelper, FinalStay, FinalTravel } from "@/emails/final-details";
import { dayOfMonth } from "@/lib/email/celebrations";
import { telHref, whatsappHref } from "@/lib/content/phone";
import type { SiteContent } from "@/lib/content/schema";

// The final emails' parts, from the site text as it is when they're sent. Without the email
// renderer, so the admin's page can write the same parts into a WhatsApp message.

/** A link of the site's travel cards as an address that works in an email. */
export function absoluteUrl(href: string | undefined, siteUrl: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("/")) return `${siteUrl}${href}`;
  if (href.startsWith("#")) return `${siteUrl}/home${href}`;
  return href;
}

export function finalHelpers(content: SiteContent): FinalHelper[] {
  return content.helpers.map((helper) => ({
    name: helper.name,
    phone: helper.phone,
    note: helper.note,
    callUrl: telHref(helper.phone),
    whatsappUrl: whatsappHref(helper.phone),
  }));
}

/** The travel cards but Where to stay, which has its own part with the places themselves. */
export function finalTravel(content: SiteContent, siteUrl: string): FinalTravel[] {
  return content.travel
    .filter((item) => item.href !== "/stay")
    .map((item) => {
      const url = absoluteUrl(item.href, siteUrl);
      return {
        title: item.title,
        lines: item.text.split("\n").map((line) => line.trim()).filter(Boolean),
        link: url ? { label: item.link, url } : undefined,
      };
    });
}

export function finalStays(content: SiteContent): FinalStay[] {
  return content.stays.map((stay) => ({
    name: stay.name,
    price: stay.price,
    phone: stay.phone,
    callUrl: stay.phone ? telHref(stay.phone) : undefined,
    note: stay.note,
  }));
}

/** The wedding day as the site writes it, e.g. "Saturday 5 December": the white wedding's. */
export function weddingDay(content: SiteContent): string {
  const first = content.celebrations.find((celebration) => celebration.id === "ceremony") ?? content.celebrations[0];
  return first ? `${first.weekday} ${dayOfMonth(first.day)} ${first.month}` : "the day";
}
