import { readSection } from "@/lib/content/store";
import { slotViews, SLOT_GROUPS } from "@/lib/site-images/admin";
import { allSlots } from "@/lib/site-images/slots";
import { readAllSiteImages } from "@/lib/site-images/store";
import { SitePhotosEditor } from "./SitePhotosEditor";

/** Every slot as saved now, read at request time. Render it only inside AdminGate. */
export async function SitePhotos() {
  const [rows, { value: party }] = await Promise.all([readAllSiteImages(), readSection("party")]);
  const views = slotViews(allSlots(party), rows);
  const groups = SLOT_GROUPS.map((group) => ({ ...group, slots: views.filter((view) => view.group === group.id) })).filter(
    (group) => group.slots.length > 0,
  );
  return <SitePhotosEditor groups={groups} />;
}
