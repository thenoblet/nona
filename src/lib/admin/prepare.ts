import "server-only";
import { partyPhotos } from "@/content/images";
import { contentDefaults } from "@/lib/content/defaults";
import type { SectionKey } from "@/lib/content/schema";
import { describeDate } from "./content";

// Run by the save action before the schema checks an edited section.

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trims text; empty text becomes `empty` (null or undefined). Anything else is left for the schema. */
function optionalText<TEmpty extends null | undefined>(value: unknown, empty: TEmpty): unknown {
  if (value === undefined || value === null) return empty;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? empty : trimmed;
}

function without(item: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== key));
}

/** Sets `key` to the trimmed text, or removes it when the text is empty. */
function withOptional(item: JsonObject, key: string): JsonObject {
  const value = optionalText(item[key], undefined);
  return value === undefined ? without(item, key) : { ...item, [key]: value };
}

/** "9:30" and "14.30" (a phone's number pad has no colon) are read as "09:30" and "14:30". */
function optionalTime(value: unknown): unknown {
  const time = optionalText(value, null);
  if (typeof time !== "string") return time;
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(time);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : time;
}

/** A link is trimmed; a space left inside it is refused by the schema with its own message. */
function trimmedLink(item: JsonObject, key: string): JsonObject {
  const value = item[key];
  return typeof value === "string" ? { ...item, [key]: value.trim() } : item;
}

function prepareCelebration(item: unknown): unknown {
  if (!isObject(item)) return item;
  const described = typeof item.date === "string" ? describeDate(item.date) : null;
  const prepared: JsonObject = {
    ...withOptional(item, "placeDetail"),
    startTime: optionalTime(item.startTime),
    endTime: optionalTime(item.endTime),
  };
  if (described) {
    // The day words always follow the date; the couple never type them.
    prepared.weekday = described.weekday;
    prepared.weekdayShort = described.weekdayShort;
    prepared.day = described.day;
    prepared.month = described.month;
  }
  return prepared;
}

/** A typed coordinate as a number, nothing when empty, or the text itself for the schema to refuse. */
function coordinate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return /^[+-]?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function prepareVenue(venue: unknown): unknown {
  if (!isObject(venue)) return venue;
  const prepared = trimmedLink(withOptional(venue, "note"), "mapsUrl");
  if (!isObject(venue.coords)) return prepared;
  const lat = coordinate(venue.coords.lat);
  const lng = coordinate(venue.coords.lng);
  // Both empty means no pin on the map; one alone is refused by the schema.
  return lat === undefined && lng === undefined ? without(prepared, "coords") : { ...prepared, coords: { lat, lng } };
}

/** "Ɔkyeame Ɛsi Bóakye" → "okyeame-esi-boakye", the form of a party member's id. */
function slugFrom(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ɔ/g, "o")
      .replace(/ɛ/g, "e")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "member"
  );
}

/**
 * Ids a new member must not take even when no one in the list has them: portraits are found by
 * id, so a new "Lilian" must not show the old Lilian's photo.
 */
const reservedPartyIds = [...contentDefaults.party.map((member) => member.id), ...Object.keys(partyPhotos)];

/** New members (no id yet) get one from their name, unique in the list; existing ids never change. */
function prepareParty(party: unknown): unknown {
  if (!Array.isArray(party)) return party;
  const taken = new Set([
    ...reservedPartyIds,
    ...party.filter(isObject).flatMap((member) => (typeof member.id === "string" && member.id !== "" ? [member.id] : [])),
  ]);
  return party.map((member) => {
    if (!isObject(member)) return member;
    // An unticked "lead" box is left out, as in the built-in list.
    const prepared = member.lead === true ? member : without(member, "lead");
    if (typeof member.id === "string" && member.id !== "") return prepared;
    const base = slugFrom(typeof member.name === "string" ? member.name : "");
    let id = base;
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
    taken.add(id);
    return { ...prepared, id };
  });
}

function mapItems(value: unknown, prepare: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(prepare) : value;
}

/**
 * Tidies an edited section before the schema checks it: derives the celebrations' day words from
 * their dates, turns empty optional fields into null or nothing, reads typed coordinates as numbers
 * and gives new party members their ids. Anything not in the expected shape is passed through, so
 * the schema refuses it with a message.
 */
export function prepareSection(key: SectionKey, value: unknown): unknown {
  switch (key) {
    case "celebrations":
      return mapItems(value, prepareCelebration);
    case "venues":
      return isObject(value)
        ? Object.fromEntries(Object.entries(value).map(([name, venue]) => [name, prepareVenue(venue)]))
        : value;
    case "schedule":
      // "Other place" posts an empty venue: the item keeps its typed place instead.
      return mapItems(value, (item) => (isObject(item) ? withOptional(item, "venue") : item));
    case "travel":
      return mapItems(value, (item) => (isObject(item) ? withOptional(item, "href") : item));
    case "party":
      return prepareParty(value);
    case "liveStream":
      return isObject(value) ? { ...value, url: optionalText(value.url, null) } : value;
    default:
      return value;
  }
}
