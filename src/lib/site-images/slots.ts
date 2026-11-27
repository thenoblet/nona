import { PREVIEW_CARD_IDS, type PreviewCardId } from "@/content/preview-photos";

/*
 * The site's own photos, by slot (spec §10.5): the landing cover and print, the home hero, the
 * invitation band, each story photo, the gallery, the photo behind each link preview card, one
 * portrait per wedding-party member (by member id) and the MC's. The couple replace any of them from the admin
 * (Site photos); until they do, a slot shows its built-in photo from src/content/images.ts. Pure:
 * the media worker bundles it (it draws the preview cards).
 */

/** The tag every cached read of the site photos carries; saving one in the admin updates it. */
export const SITE_IMAGES_TAG = "site-images";

export type SlotGroupId = "landing" | "home" | "story" | "gallery" | "previews" | "party";

export const SLOT_GROUPS: { id: SlotGroupId; name: string; note?: string }[] = [
  { id: "landing", name: "Landing page" },
  { id: "home", name: "Home" },
  { id: "story", name: "Our story" },
  { id: "gallery", name: "Gallery" },
  {
    id: "previews",
    name: "Link previews",
    note: "The card WhatsApp, iMessage and Facebook show when someone shares a link. The worker draws it from this photo.",
  },
  { id: "party", name: "Wedding party", note: "One portrait each, shown in an oval." },
];

/** How the admin previews a slot's crops: the site's usual shapes, an oval portrait, or a preview card. */
export type SlotShape = "photo" | "oval" | "card";

export type SlotDefinition = {
  id: string;
  group: SlotGroupId;
  /** The slot's name in the admin. */
  name: string;
  /** Where guests see it, in the admin's words. */
  where: string;
  shape: SlotShape;
  /**
   * The widest the slot's photo is drawn, in pixels, at twice the CSS width on any screen up to
   * 1440 px: the largest size its srcset lists (Ruling CI).
   */
  maxWidth: number;
  /** The link preview card this slot's photo is drawn into. */
  preview?: PreviewCardId;
  /** A photo behind text, which screen readers skip (alt=""): its alt text is kept, never read aloud. */
  decorative?: true;
};

/** The MC's portrait: the host card under the wedding party, and "Hosted by" on the programme. */
export const HOST_SLOT_ID = "host-portrait";

const FIXED_SLOTS: SlotDefinition[] = [
  {
    id: "landing-cover",
    group: "landing",
    name: "Landing cover",
    where: "The big photo on the page guests open first.",
    shape: "photo",
    // 100vw up to 1023 px, then 47vw.
    maxWidth: 2046,
  },
  {
    id: "landing-print",
    group: "landing",
    name: "Landing print",
    where: "The small print tucked into the cover, “she said yes”.",
    shape: "photo",
    maxWidth: 460,
  },
  {
    id: "home-hero",
    group: "home",
    name: "Home hero",
    where: "Behind your names at the top of the home page, until the wedding weekend ends; darkened so they stay clear.",
    shape: "photo",
    maxWidth: 2880,
    decorative: true,
  },
  {
    id: "invitation-band",
    group: "home",
    name: "Invitation band",
    where: "The band of flowers behind the letter to guests.",
    shape: "photo",
    maxWidth: 2880,
    decorative: true,
  },
  {
    id: "story-met-arch",
    group: "story",
    name: "How we met: arch",
    where: "The arched photo beside “How we met”.",
    shape: "photo",
    maxWidth: 640,
  },
  {
    id: "story-met-print",
    group: "story",
    name: "How we met: print",
    where: "The small print captioned “the early days”.",
    shape: "photo",
    maxWidth: 240,
  },
  {
    id: "story-met-second-print",
    group: "story",
    name: "How we met: second print",
    where: "The small print captioned “all dressed up”, on the other side of the arch.",
    shape: "photo",
    maxWidth: 240,
  },
  {
    id: "story-asked-arch",
    group: "story",
    name: "The night he asked: arch",
    where: "The arched photo beside “The night he asked”.",
    shape: "photo",
    maxWidth: 640,
  },
  {
    id: "story-asked-print",
    group: "story",
    name: "The night he asked: print",
    where: "The small print captioned “yes!”.",
    shape: "photo",
    maxWidth: 240,
  },
  {
    id: "story-forever-arch",
    group: "story",
    name: "Forever begins: arch",
    where: "The arched photo beside “Forever begins”.",
    shape: "photo",
    maxWidth: 640,
  },
  {
    id: "story-forever-print",
    group: "story",
    name: "Forever begins: print",
    where: "The small print captioned “just us”.",
    shape: "photo",
    maxWidth: 240,
  },

  {
    id: "gallery-left",
    group: "gallery",
    name: "Gallery: left print",
    where: "Under the wedding party, on the left.",
    shape: "photo",
    maxWidth: 460,
  },
  {
    id: "gallery-centre",
    group: "gallery",
    name: "Gallery: centre arch",
    where: "The tall arch in the middle (tablets and laptops only).",
    shape: "photo",
    maxWidth: 600,
  },
  {
    id: "gallery-right",
    group: "gallery",
    name: "Gallery: right print",
    where: "Under the wedding party, on the right.",
    shape: "photo",
    maxWidth: 460,
  },
  {
    id: "preview-invitation",
    group: "previews",
    name: "Home, and any page without its own",
    where: "Shared links to the home page and the invitation.",
    shape: "card",
    maxWidth: 1200,
    preview: "invitation",
  },
  {
    id: "preview-rsvp",
    group: "previews",
    name: "RSVP",
    where: "Shared links to the reply form.",
    shape: "card",
    maxWidth: 1200,
    preview: "rsvp",
  },
  {
    id: "preview-album",
    group: "previews",
    name: "Album",
    where: "The table QR codes and shared album links.",
    shape: "card",
    maxWidth: 1200,
    preview: "album",
  },
  {
    id: "preview-wishes",
    group: "previews",
    name: "Wishes",
    where: "Shared links to the guestbook.",
    shape: "card",
    maxWidth: 1200,
    preview: "wishes",
  },
];

/** Listed in Site photos after the wedding party's portraits. */
const HOST_SLOT: SlotDefinition = {
  id: HOST_SLOT_ID,
  group: "party",
  name: "MC",
  where: "The host card under the wedding party, and beside “Hosted by” in the order of the day.",
  shape: "oval",
  // An oval of at most 140 px across.
  maxWidth: 280,
};

const FIXED_BY_ID = new Map([...FIXED_SLOTS, HOST_SLOT].map((slot) => [slot.id, slot]));

/** A wedding-party member's portrait slot: `party-<member id>`. */
export function partySlotId(memberId: string): string {
  return `party-${memberId}`;
}

/** The portrait slot of a member as the site text lists them. */
export function partySlot(member: { id: string; name: string; role: string }): SlotDefinition {
  // An oval of at most 176 px across.
  return { id: partySlotId(member.id), group: "party", name: member.name, where: member.role, shape: "oval", maxWidth: 352 };
}

/** Every slot: the fixed ones, one per member of the wedding party as the site text has it now, then the MC. */
export function allSlots(party: { id: string; name: string; role: string }[]): SlotDefinition[] {
  return [...FIXED_SLOTS, ...party.map(partySlot), HOST_SLOT];
}

// A party member's id is a lower-case slug (the site text's own rule).
const PARTY_SLOT = /^party-[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLOT_CHARACTERS = 120;

/** Whether the value names a slot: a fixed one, or a member's portrait. Checked before anything is saved under it. */
export function isSlotId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SLOT_CHARACTERS && (FIXED_BY_ID.has(value) || PARTY_SLOT.test(value));
}

/** The fixed slot with this id, or a member's portrait slot (named by its id until the site text names it). */
export function slotDefinition(slotId: string, party: { id: string; name: string; role: string }[] = []): SlotDefinition | null {
  const fixed = FIXED_BY_ID.get(slotId);
  if (fixed) return fixed;
  if (!PARTY_SLOT.test(slotId)) return null;
  const memberId = slotId.slice("party-".length);
  const member = party.find((candidate) => candidate.id === memberId);
  return partySlot(member ?? { id: memberId, name: memberId, role: "Wedding party" });
}

/** The preview card a slot's photo is drawn into, if it is one of the four. */
export function previewOf(slotId: string): PreviewCardId | null {
  return FIXED_BY_ID.get(slotId)?.preview ?? null;
}

/** The slot behind a preview card. */
export function previewSlotId(card: PreviewCardId): string {
  return `preview-${card}`;
}

export { PREVIEW_CARD_IDS, type PreviewCardId };
