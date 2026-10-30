import { describeDate } from "@/lib/admin/content";
import type { SectionKey } from "@/lib/content/schema";
import { getAt } from "./editing";

// How each section's form is drawn. One editor renders all ten from these, so a section's
// fields are listed here rather than in a form of its own.

type Item = unknown;

export type FieldSpec = {
  /** Where the value sits in an item (or in a group), e.g. ["coords", "lat"]; [] for a list of plain text. */
  path: readonly string[];
  label: string;
  kind: "text" | "textarea" | "link" | "time" | "date" | "decimal" | "select" | "checkbox";
  /** Columns out of six on wide screens. Phones use two columns: span 1 is half, the rest full. */
  span: 1 | 2 | 3 | 4 | 6;
  hint?: string | ((item: Item) => string | undefined);
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
  /** A one-line text that often runs long starts two lines tall, as in the approved design. */
  rows?: 2;
};

/** A list of items, each in its own fieldset. `editable` lists can add, remove and reorder. */
export type ListSpec = {
  layout: "list";
  fields: readonly FieldSpec[];
  legend: (item: Item, index: number) => string;
  note?: (item: Item) => string | undefined;
  editable?: {
    noun: string;
    addLabel: string;
    newItem: (list: readonly Item[]) => Item;
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

const chapterFields = (body: "text" | "quote"): readonly FieldSpec[] => [
  { path: ["when"], label: "When", kind: "text", span: 2 },
  { path: ["title"], label: "Title", kind: "text", span: 4 },
  { path: [body], label: body === "quote" ? "His words" : "Text", kind: "textarea", span: 6 },
  ...(body === "quote" ? [{ path: ["answer"], label: "Her answer", kind: "text", span: 6 } as const] : []),
];

export const sectionSpecs: Record<SectionKey, SectionSpec> = {
  celebrations: {
    layout: "list",
    legend: named("name", "Celebration"),
    fields: [
      { path: ["name"], label: "Name", kind: "text", span: 4 },
      { path: ["date"], label: "Date", kind: "date", span: 2, hint: (item) => describeDate(text(item, "date"))?.long },
      { path: ["startTime"], label: "Starts", kind: "time", span: 1 },
      { path: ["endTime"], label: "Ends", kind: "time", span: 1, placeholder: OPTIONAL },
      {
        path: ["time"],
        label: "Guests see",
        kind: "text",
        rows: 2,
        span: 4,
        hint: "Shown on the site. Calendars use the start and end times.",
      },
      { path: ["place"], label: "Place", kind: "text", rows: 2, span: 3 },
      { path: ["placeDetail"], label: "Place detail", kind: "text", rows: 2, span: 3, placeholder: OPTIONAL },
      { path: ["dress"], label: "Dress code", kind: "text", span: 3 },
      { path: ["directionsUrl"], label: "Directions link", kind: "link", span: 3, hint: LINK_HINT },
    ],
  },
  schedule: {
    layout: "list",
    legend: named("title", "Item"),
    fields: [
      { path: ["time"], label: "Time", kind: "text", span: 2 },
      { path: ["title"], label: "What happens", kind: "text", span: 4 },
      { path: ["place"], label: "Place", kind: "text", span: 4 },
      {
        path: ["day"],
        label: "Day",
        kind: "select",
        span: 2,
        options: [
          { value: "sat", label: "Saturday" },
          { value: "sun", label: "Sunday" },
        ],
      },
    ],
    editable: {
      noun: "item",
      addLabel: "Add an item",
      newItem: (list) => ({ time: "", title: "", place: "", day: getAt(list.at(-1), ["day"]) ?? "sat" }),
    },
  },
  venues: {
    layout: "groups",
    groups: [
      { key: "church", legend: "Church", fields: venueFields },
      { key: "reception", legend: "Reception", fields: venueFields },
      { key: "hotel", legend: "Hotel", fields: venueFields },
    ],
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
    legend: named("q", "Question"),
    note: (item) =>
      isLiveStreamQuestion(item)
        ? "Shown only when a live stream link is set. It can't be removed: the live stream switch uses it."
        : undefined,
    fields: [
      { path: ["q"], label: "Question", kind: "text", span: 6 },
      { path: ["a"], label: "Answer", kind: "textarea", span: 6 },
    ],
    editable: {
      noun: "question",
      addLabel: "Add a question",
      newItem: () => ({ q: "", a: "" }),
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
      { path: ["href"], label: "Link", kind: "link", span: 4, placeholder: OPTIONAL, hint: LINK_HINT },
    ],
  },
  gifts: {
    layout: "list",
    legend: named("title", "Gift"),
    fields: [
      { path: ["title"], label: "Title", kind: "text", span: 3 },
      { path: ["action"], label: "Button text", kind: "text", span: 3 },
      { path: ["text"], label: "Text", kind: "textarea", span: 6 },
    ],
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
  return items.flatMap((item, index) =>
    spec.fields.map((field) => ({
      path: [index, ...field.path].join("."),
      name: spec.fields.length === 1 ? spec.legend(item, index) : `${spec.legend(item, index)} · ${field.label}`,
    })),
  );
}
