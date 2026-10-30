import type { FaqItem, SiteContent } from "./schema";

const ONE_HOUR_MS = 60 * 60 * 1000;

/** The ceremony's start as an instant. Times are Tepa's, which is UTC+0 all year. */
function ceremonyStart(content: SiteContent): number {
  const ceremony = content.celebrations.find((celebration) => celebration.id === "ceremony");
  if (!ceremony) return Number.POSITIVE_INFINITY;
  return Date.parse(`${ceremony.date}T${ceremony.startTime ?? "00:00"}:00Z`);
}

/** Guests see "Watch live" once there is a link and it is an hour to the ceremony. Call at request time only. */
export function liveStreamState(content: SiteContent, now: Date): { show: boolean; url: string | null } {
  const { url } = content.liveStream;
  const show = url !== null && now.getTime() >= ceremonyStart(content) - ONE_HOUR_MS;
  return { show, url };
}

/** The FAQ without the live-stream answer while there is no link. */
export function visibleFaq(content: SiteContent): FaqItem[] {
  if (content.liveStream.url) return content.faq;
  return content.faq.filter((item) => item.topic !== "live-stream");
}
