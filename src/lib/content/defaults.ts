import { celebrations, faq, gifts, landmarks, liveStream, party, schedule, story, travel, venues } from "@/content/wedding";
import { sectionSchemas, type SiteContent } from "./schema";

/**
 * The built-in text, used wherever the couple have not saved their own. Parsing through the
 * schemas copies the readonly `as const` data into the mutable section types and fails loudly
 * at start-up if the built-in text ever stops being valid.
 */
export const contentDefaults: SiteContent = {
  celebrations: sectionSchemas.celebrations.parse(celebrations),
  schedule: sectionSchemas.schedule.parse(schedule),
  venues: sectionSchemas.venues.parse(venues),
  landmarks: sectionSchemas.landmarks.parse(landmarks),
  faq: sectionSchemas.faq.parse(faq),
  travel: sectionSchemas.travel.parse(travel),
  gifts: sectionSchemas.gifts.parse(gifts),
  party: sectionSchemas.party.parse(party),
  story: sectionSchemas.story.parse(story),
  liveStream: sectionSchemas.liveStream.parse(liveStream),
};
