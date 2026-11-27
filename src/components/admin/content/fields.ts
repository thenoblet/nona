import { describeDate } from "@/lib/admin/content";
import type { ContentSectionKey } from "@/lib/admin/content";
import { celebrationPlace } from "@/lib/content/place";
import { CELEBRATION_VENUES, EVENT_LABELS, GUEST_EVENT_IDS, VENUE_KEYS, VENUE_LABELS, type SiteContent } from "@/lib/content/schema";
import { endsNextDay } from "@/lib/content/times";
import { getAt } from "./editing";

// How each section's form is drawn. One editor renders all of them from these, so a section's
// fields are listed here rather than in a form of its own.

type Item = unknown;

/**
 * What a hint may show besides its own item: the saved venues, where each celebration's place
 * comes from. Read only for the celebrations; null elsewhere.
 */
export type EditorContext = { venues: SiteContent["venues"] | null };

export type FieldSpec = {
  /** Where the value sits in an item (or in a group), e.g. ["coords", "lat"]; [] for a list of plain text. */
  path: readonly string[];
  label: string;
  kind: "text" | "textarea" | "link" | "time" | "date" | "decimal" | "select" | "checkbox";
  /** Columns out of six on wide screens. Phones use two columns: span 1 is half, the rest full. */
  span: 1 | 2 | 3 | 4 | 6;
  hint?: string | ((item: Item, context: EditorContext) => string | undefined);
  /** Shown only for items it fits, such as a typed place for an item at no venue. */
  shownFor?: (item: Item) => boolean;
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
  /** A one-line text that often runs long starts two lines tall, as in the approved design. */
  rows?: 2;
};

/**
 * Shows a list's items under a heading for each value of one field (the order of the day by
 * celebration). The list is still saved as one list; items move up and down within their group.
 */
export type GroupBy = {
  path: readonly string[];
  groups: readonly { value: string; label: string }[];
};

/** A list of items, each in its own fieldset. `editable` lists can add, remove and reorder. */
export type ListSpec = {
  layout: "list";
  fields: readonly FieldSpec[];
  legend: (item: Item, index: number) => string;
  note?: (item: Item) => string | undefined;
  groupBy?: GroupBy;
  editable?: {
    noun: string;
    /** The add button's text; in a grouped list it is given the group's label. */
    addLabel: string | ((groupLabel: string) => string);
    /** A new item, given the list and, in a grouped list, the group it is added to. */
    newItem: (list: readonly Item[], group?: string) => Item;
    /** Items the site depends on can be edited and moved but not removed. */
    removable?: (item: Item) => boolean;
  };
  hint?: string;
};

/** Fixed named parts of one object (venues, story chapters); `key: null` is the section itself. */
export type GroupsSpec = {
  layout: "groups";
  groups: readonly { key: string | null; legend: string; fields: readonly FieldSpec[] }[];
  hint?: string;
};

export type SectionSpec = ListSpec | GroupsSpec;

const OPTIONAL = "Optional";
const LINK_HINT = "An https:// link, or #map for the map on the page.";

function text(item: Item, ...path: string[]): string {
  const value = getAt(item, path);
  return typeof value === "string" ? value.trim() : "";
}

/** The question shown with the live stream link (see visibleFaq in src/lib/content/live.ts). */
function isLiveStreamQuestion(item: Item): boolean {
  return getAt(item, ["topic"]) === "live-stream";
}

/** "Guests arrive" for a named item, "Item 3" until it has a name. */
function named(path: string, fallback: string) {
  return (item: Item, index: number) => text(item, path) || `${fallback} ${index + 1}`;
}

const venueFields: readonly FieldSpec[] = [
  { path: ["name"], label: "Name", kind: "text", span: 4 },
  { path: ["gps"], label: "GhanaPost GPS", kind: "text", span: 2 },
  { path: ["address"], label: "Address", kind: "text", span: 3 },
  { path: ["note"], label: "Note", kind: "text", span: 3, placeholder: OPTIONAL },
  { path: ["mapsUrl"], label: "Maps link", kind: "link", span: 6, hint: LINK_HINT },
  {
    path: ["coords", "lat"],
    label: "Latitude",
    kind: "decimal",
    span: 3,
    placeholder: OPTIONAL,
    hint: "Leave both empty for no pin on the map.",
  },
  { path: ["coords", "lng"], label: "Longitude", kind: "decimal", span: 3, placeholder: OPTIONAL },
];

const celebrationVenueOptions = CELEBRATION_VENUES.map((venue) => ({ value: venue, label: VENUE_LABELS[venue] }));

/** "Place, GPS and directions come from Venues → Church: Assemblies of God, Victory Worship Centre, Tepa (no GPS yet)". */
function venueHint(item: Item, { venues }: EditorContext): string | undefined {
  const venue = CELEBRATION_VENUES.find((key) => key === getAt(item, ["venue"]));
  if (!venue || !venues) return undefined;
  const { place, gpsLine } = celebrationPlace({ venue }, venues);
  return `Place, GPS and directions come from Venues → ${VENUE_LABELS[venue]}: ${place}${gpsLine ? ` · ${gpsLine}` : " (no GPS yet)"}`;
}

/** The order of the day is grouped by celebration, in the order they happen. */
const celebrationGroups = GUEST_EVENT_IDS.map((id) => ({ value: id, label: EVENT_LABELS[id] }));

const chapterFields = (body: "text" | "quote"): readonly FieldSpec[] => [
  { path: ["when"], label: "When", kind: "text", span: 2 },
  { path: ["title"], label: "Title", kind: "text", span: 4 },
  { path: [body], label: body === "quote" ? "His words" : "Text", kind: "textarea", span: 6 },
  ...(body === "quote" ? [{ path: ["answer"], label: "Her answer", kind: "text", span: 6 } as const] : []),
];

export const sectionSpecs: Record<ContentSectionKey, SectionSpec> = {
  celebrations: {
    layout: "list",
    legend: named("name", "Celebration"),
    fields: [
      { path: ["name"], label: "Name", kind: "text", span: 4 },
      { path: ["date"], label: "Date", kind: "date", span: 2, hint: (item) => describeDate(text(item, "date"))?.long },
      { path: ["startTime"], label: "Starts", kind: "time", span: 1 },
      {
        path: ["endTime"],
        label: "Ends",
        kind: "time",
        span: 1,
        placeholder: OPTIONAL,
        // An end before the start is read as the next day; say so, so a mistyped time shows.
        hint: (item) => (endsNextDay(text(item, "startTime"), text(item, "endTime")) ? "Ends after midnight" : undefined),
      },
      {
        path: ["time"],
        label: "Guests see",
        kind: "text",
        rows: 2,
        span: 4,
        hint: "Shown on the site. Calendars use the start and end times.",
      },
      { path: ["venue"], label: "Venue", kind: "select", span: 3, options: celebrationVenueOptions, hint: venueHint },
      {
        path: ["placeDetail"],
        label: "Extra place note",
        kind: "text",
        span: 3,
        placeholder: OPTIONAL,
        hint: "Shown under the place and GPS, e.g. “Main hall, upstairs”.",
      },
      { path: ["dress"], label: "Dress code", kind: "text", span: 6 },
    ],
  },
  schedule: {
    layout: "list",
    // Numbers would count across the celebrations ("Item 20" in the reception), so a new one is just new.
    legend: (item) => text(item, "title") || "New item",
    groupBy: { path: ["celebration"], groups: celebrationGroups },
    fields: [
      { path: ["time"], label: "Time", kind: "time", span: 1, placeholder: OPTIONAL },
      { path: ["title"], label: "What happens", kind: "text", span: 3 },
      { path: ["celebration"], label: "Celebration", kind: "select", span: 2, options: celebrationGroups },
      { path: ["note"], label: "Note", kind: "text", span: 3, placeholder: OPTIONAL },
      {
        path: ["place"],
        label: "Place",
        kind: "text",
        span: 3,
        placeholder: "At the celebration’s venue",
        hint: "Only if it happens somewhere else.",
      },
    ],
    editable: {
      noun: "item",
      addLabel: (groupLabel) => `Add an item to the ${groupLabel}`,
      newItem: (_list, group) => ({ celebration: group ?? "ceremony", time: "", title: "", note: "", place: "" }),
    },
    hint:
      "Guests see this on the Order of the day page, grouped by celebration. Leave a time empty when it has none. On the day, the item whose time has passed shows as Happening now.",
  },
  venues: {
    layout: "groups",
    groups: VENUE_KEYS.map((venue) => ({ key: venue, legend: VENUE_LABELS[venue], fields: venueFields })),
  },
  landmarks: {
    layout: "list",
    legend: (_item, index) => `Landmark ${index + 1}`,
    fields: [{ path: [], label: "Name", kind: "text", span: 6 }],
    editable: { noun: "landmark", addLabel: "Add a landmark", newItem: () => "" },
    hint: "Shown over the map as places guests can ask for on the way.",
  },
  faq: {
    layout: "list",
    legend: named("question", "Question"),
    note: (item) =>
      isLiveStreamQuestion(item)
        ? "Shown only when a live stream link is set. It can't be removed: the live stream switch uses it."
        : undefined,
    fields: [
      { path: ["question"], label: "Question", kind: "text", span: 6 },
      { path: ["answer"], label: "Answer", kind: "textarea", span: 6 },
    ],
    editable: {
      noun: "question",
      addLabel: "Add a question",
      newItem: () => ({ question: "", answer: "" }),
      removable: (item) => !isLiveStreamQuestion(item),
    },
  },
  travel: {
    layout: "list",
    legend: named("title", "Card"),
    fields: [
      {
        path: ["icon"],
        label: "Icon",
        kind: "select",
        span: 2,
        options: [
          { value: "bed", label: "Bed" },
          { value: "pin", label: "Map pin" },
          { value: "heart", label: "Heart" },
        ],
      },
      { path: ["title"], label: "Title", kind: "text", span: 4 },
      { path: ["text"], label: "Text", kind: "textarea", span: 6 },
      { path: ["link"], label: "Link text", kind: "text", span: 2 },
      {
        path: ["href"],
        label: "Link",
        kind: "link",
        span: 4,
        placeholder: OPTIONAL,
        hint: "An https:// link, a page of the site like /stay, or #map for the map on the page.",
      },
    ],
  },
  stays: {
    layout: "list",
    legend: named("name", "Place"),
    fields: [
      { path: ["name"], label: "Name", kind: "text", span: 4 },
      { path: ["tag"], label: "Label", kind: "text", span: 2, placeholder: OPTIONAL, hint: "Over the name, e.g. “Closest to the church”." },
      { path: ["distance"], label: "How far", kind: "text", span: 3, placeholder: "About 1 km from the church" },
      { path: ["price"], label: "Price", kind: "text", span: 3, placeholder: OPTIONAL },
      { path: ["phone"], label: "Phone", kind: "text", span: 2, placeholder: OPTIONAL, hint: "Guests tap Call to ring it." },
      { path: ["mapsUrl"], label: "Google Maps link", kind: "link", span: 4, placeholder: OPTIONAL, hint: "Opens when guests tap Directions." },
      { path: ["note"], label: "Note", kind: "text", span: 6, placeholder: OPTIONAL, hint: "Under the buttons, e.g. “Book through the main house”." },
    ],
    editable: {
      noun: "place",
      addLabel: "Add a place to stay",
      newItem: () => ({ name: "", tag: "", distance: "", price: "", phone: "", mapsUrl: "", note: "" }),
    },
    hint: "Guests see these on the Where to stay page, in this order: put the closest first.",
  },
  helpers: {
    layout: "list",
    legend: named("name", "Helper"),
    fields: [
      { path: ["name"], label: "Name", kind: "text", span: 3 },
      { path: ["phone"], label: "Phone", kind: "text", span: 3, hint: "Guests tap Call or WhatsApp." },
      {
        path: ["note"],
        label: "What they help with",
        kind: "text",
        span: 6,
        placeholder: OPTIONAL,
        hint: "Under their number, e.g. “Directions and parking”.",
      },
    ],
    editable: {
      noun: "helper",
      addLabel: "Add a helper",
      newItem: () => ({ name: "", phone: "", note: "" }),
    },
    hint: "Guests see these on Today, the home page and the RSVP thank-you, in this order. With none, the help card doesn't show.",
  },
  party: {
    layout: "list",
    legend: named("name", "Member"),
    fields: [
      { path: ["name"], label: "Name", kind: "text", span: 3 },
      { path: ["role"], label: "Role", kind: "text", span: 3 },
      { path: ["lead"], label: "Lead", kind: "checkbox", span: 6 },
    ],
    editable: {
      noun: "member",
      addLabel: "Add a member",
      newItem: () => ({ id: "", name: "", role: "" }),
    },
    hint:
      "Leads (the maid of honour and best man) are shown first, with larger portraits. A new member shows a “coming soon” oval in place of a portrait until photos can be added here; renaming someone keeps their photo.",
  },
  host: {
    layout: "groups",
    groups: [
      {
        key: null,
        legend: "The MC",
        fields: [
          { path: ["name"], label: "Name", kind: "text", span: 3 },
          { path: ["role"], label: "Role", kind: "text", span: 3 },
          {
            path: ["note"],
            label: "What he does",
            kind: "text",
            span: 6,
            placeholder: OPTIONAL,
            hint: "One line under his name, e.g. “He will guide you through the reception”.",
          },
          { path: ["hidden"], label: "Hide him from the site", kind: "checkbox", span: 6 },
        ],
      },
    ],
    hint: "Guests see him in a card under the wedding party on the home page, and as “Hosted by” on the reception in the order of the day. His photo is in Site photos.",
  },
  story: {
    layout: "groups",
    groups: [
      { key: "met", legend: "How we met", fields: chapterFields("text") },
      { key: "asked", legend: "The night he asked", fields: chapterFields("quote") },
      { key: "forever", legend: "Forever begins", fields: chapterFields("text") },
    ],
  },
  liveStream: {
    layout: "groups",
    groups: [
      {
        key: null,
        legend: "Live stream link",
        fields: [
          {
            path: ["url"],
            label: "Link",
            kind: "link",
            span: 6,
            placeholder: "https://",
            hint: "Guests see a “Watch live” button from an hour before the ceremony starts. Leave it empty to hide it.",
          },
        ],
      },
    ],
  },
};

/** A section's name inside a sentence: "Wedding party" → "wedding party", while "MC" stays "MC". */
export function inSentence(label: string): string {
  return label
    .split(" ")
    .map((word) => (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word) ? word : word.toLowerCase()))
    .join(" ");
}

/** The fields a list item shows: a field meant only for some items is left out of the rest. */
export function fieldsFor(spec: ListSpec, item: Item): readonly FieldSpec[] {
  return spec.fields.filter((field) => field.shownFor?.(item) ?? true);
}

/**
 * Every field's place and name in form order, e.g. { path: "0.endTime", name: "White wedding · Ends" }:
 * the save bar names the first problem by it.
 */
export function fieldsInOrder(spec: SectionSpec, value: unknown): { path: string; name: string }[] {
  if (spec.layout === "groups") {
    return spec.groups.flatMap((group) =>
      group.fields.map((field) => ({
        path: [...(group.key === null ? [] : [group.key]), ...field.path].join("."),
        name: `${group.legend} · ${field.label}`,
      })),
    );
  }
  const items = Array.isArray(value) ? value : [];
  return groupedIndexes(spec, items).flatMap(({ label, indexes }) =>
    indexes.flatMap((index) => {
      const item = items[index];
      const legend = label ? `${label} · ${spec.legend(item, index)}` : spec.legend(item, index);
      return fieldsFor(spec, item).map((field) => ({
        path: [index, ...field.path].join("."),
        name: spec.fields.length === 1 ? legend : `${legend} · ${field.label}`,
      }));
    }),
  );
}

/**
 * A list's items as the editor shows them: under each group's heading in a grouped list (an item in
 * none comes last, under no heading), or all together. Each index points into the saved list.
 */
export function groupedIndexes(
  spec: ListSpec,
  items: readonly Item[],
): { value: string | null; label: string | null; indexes: number[] }[] {
  const all = items.map((_item, index) => index);
  if (!spec.groupBy) return [{ value: null, label: null, indexes: all }];
  const { path, groups } = spec.groupBy;
  const known = new Set(groups.map((group) => group.value));
  const sections = groups.map((group) => ({
    value: group.value,
    label: group.label,
    indexes: all.filter((index) => getAt(items[index], path) === group.value),
  }));
  const rest = all.filter((index) => !known.has(String(getAt(items[index], path))));
  return rest.length > 0 ? [...sections, { value: null, label: null, indexes: rest }] : sections;
}

/**
 * Where an item of group `value` goes so the list stays grouped in the order the editor shows it:
 * after the last item of its group, or of the groups before it. The save keeps the same order, so
 * the place of a problem it reports is the place of the field on screen.
 */
export function groupEnd(spec: ListSpec, items: readonly Item[], value: string): number {
  if (!spec.groupBy) return items.length;
  const { path, groups } = spec.groupBy;
  const order = (groupValue: unknown) => {
    const position = groups.findIndex((group) => group.value === groupValue);
    return position < 0 ? groups.length : position;
  };
  const target = order(value);
  let end = 0;
  items.forEach((item, index) => {
    if (order(getAt(item, path)) <= target) end = index + 1;
  });
  return end;
}
