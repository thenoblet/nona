import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";
import { describe, expect, it } from "vitest";
import type { Celebration, EventId } from "@/lib/content/schema";
import { assignCelebration } from "./celebration";

/** A celebration's start and end as the admin stores them: "HH:MM" or null. */
type Times = [startTime: string | null, endTime: string | null];

type Row = {
  name: string;
  celebrations: Celebration[];
  /** ISO, always with its `Z`; null when the file had no capture time; anything else is unreadable. */
  capturedAt: string | null;
  uploadedAt: string;
  expected: EventId | "more";
};

const SATURDAY = "2026-12-05";
const SUNDAY = "2026-12-06";
/** The upload time for rows with a capture time: a day that is More moments, so using it by mistake shows. */
const AFTER_THE_WEEKEND = "2026-12-08T09:00:00Z";

/** The three celebrations with only what grouping reads changed; the rest is placeholder text. */
function weekend({
  ceremony = [null, null],
  reception = [null, null],
  thanks = [null, null],
  saturday = SATURDAY,
  sunday = SUNDAY,
}: { ceremony?: Times; reception?: Times; thanks?: Times; saturday?: string; sunday?: string } = {}): Celebration[] {
  const celebration = (id: EventId, date: string, [startTime, endTime]: Times): Celebration => ({
    id,
    venue: "church",
    name: id,
    weekday: "Day",
    weekdayShort: "Day",
    day: date.slice(8),
    month: "December",
    time: "[Start time]",
    dress: "Formal",
    date,
    startTime,
    endTime,
  });
  return [
    celebration("ceremony", saturday, ceremony),
    celebration("reception", saturday, reception),
    celebration("thanks", sunday, thanks),
  ];
}

/** No times confirmed yet, as on the live site: ceremony 10:00–13:00, reception 14:00–23:59, thanksgiving 09:00–12:00. */
const unconfirmed = weekend();
/** Confirmed times, with a reception that runs past midnight and a thanksgiving with no end (09:30–12:30). */
const confirmed = weekend({ ceremony: ["10:00", "12:30"], reception: ["14:00", "01:30"], thanks: ["09:30", null] });
/** The couple moved the whole weekend a week later in the admin. */
const movedAWeek = weekend({ saturday: "2026-12-12", sunday: "2026-12-13" });

function row(
  name: string,
  celebrations: Celebration[],
  capturedAt: string | null,
  expected: EventId | "more",
  uploadedAt = AFTER_THE_WEEKEND,
): Row {
  return { name, celebrations, capturedAt, uploadedAt, expected };
}

const table: Record<string, Row[]> = {
  "rule 1: inside a celebration's window, that celebration": [
    row("Saturday 11:00 is the white wedding", unconfirmed, "2026-12-05T11:00:00Z", "ceremony"),
    row("Saturday 18:00 is the reception", unconfirmed, "2026-12-05T18:00:00Z", "reception"),
    row("Sunday 10:30 is the thanksgiving", unconfirmed, "2026-12-06T10:30:00Z", "thanks"),
    row("a window holds its last second", weekend({ ceremony: ["10:00", "13:00"], reception: ["13:00", "23:00"] }), "2026-12-05T12:59:59Z", "ceremony"),
    row("a window's end is where the next one starts", weekend({ ceremony: ["10:00", "13:00"], reception: ["13:00", "23:00"] }), "2026-12-05T13:00:00Z", "reception"),
    row("a reception ending 01:30 claims Sunday 00:45", confirmed, "2026-12-06T00:45:00Z", "reception"),
    row("a reception ending 01:30 claims Sunday 01:29:59", confirmed, "2026-12-06T01:29:59Z", "reception"),
    row("a reception ending 01:30 leaves Sunday 01:30 to the thanksgiving", confirmed, "2026-12-06T01:30:00Z", "thanks"),
    row("a start with no end lasts three hours: 11:50 is inside", weekend({ ceremony: ["09:00", null], reception: ["12:30", "23:00"] }), "2026-12-05T11:50:00Z", "ceremony"),
    row("a start with no end lasts three hours: 12:20 is past it, nearer the reception", weekend({ ceremony: ["09:00", null], reception: ["12:30", "23:00"] }), "2026-12-05T12:20:00Z", "reception"),
    row("a missing start takes the default window and ignores a lone end", weekend({ ceremony: [null, "11:00"] }), "2026-12-05T12:50:00Z", "ceremony"),
    row("where two windows overlap, the one that started last", weekend({ ceremony: ["10:00", null], reception: ["12:00", "22:00"] }), "2026-12-05T12:30:00Z", "reception"),
    row("where two windows overlap, before the second starts", weekend({ ceremony: ["10:00", null], reception: ["12:00", "22:00"] }), "2026-12-05T11:30:00Z", "ceremony"),
  ],
  "rule 2: on Saturday outside both windows, the nearest Saturday celebration": [
    row("Saturday 08:00, getting ready, is the white wedding", unconfirmed, "2026-12-05T08:00:00Z", "ceremony"),
    row("Saturday 00:30 is the white wedding", unconfirmed, "2026-12-05T00:30:00Z", "ceremony"),
    row("between the windows, 13:20 is nearer the white wedding", unconfirmed, "2026-12-05T13:20:00Z", "ceremony"),
    row("between the windows, 13:40 is nearer the reception", unconfirmed, "2026-12-05T13:40:00Z", "reception"),
    row("halfway between the windows, 13:30, goes to the white wedding", unconfirmed, "2026-12-05T13:30:00Z", "ceremony"),
    row("between confirmed windows, 13:00 is nearer the white wedding's 12:30 end", confirmed, "2026-12-05T13:00:00Z", "ceremony"),
    row("between confirmed windows, 13:45 is nearer the reception's 14:00 start", confirmed, "2026-12-05T13:45:00Z", "reception"),
    row("the last minute of Saturday, after the default 23:59 end, is the reception", unconfirmed, "2026-12-05T23:59:30Z", "reception"),
    row("late Saturday night after a reception ending 22:00 is the reception", weekend({ reception: ["14:00", "22:00"] }), "2026-12-05T23:30:00Z", "reception"),
  ],
  "rule 3: on Sunday, the thanksgiving unless rule 1 matched": [
    row("Sunday 07:00, before the service", unconfirmed, "2026-12-06T07:00:00Z", "thanks"),
    row("Sunday 20:00, long after it", unconfirmed, "2026-12-06T20:00:00Z", "thanks"),
    row("Sunday 00:00, when the reception ended on Saturday", unconfirmed, "2026-12-06T00:00:00Z", "thanks"),
    row("Sunday 00:45, when the reception ended on Saturday", unconfirmed, "2026-12-06T00:45:00Z", "thanks"),
    row("Sunday 02:00, after a reception ending 01:30", confirmed, "2026-12-06T02:00:00Z", "thanks"),
    row("the last second of Sunday", unconfirmed, "2026-12-06T23:59:59Z", "thanks"),
  ],
  "rule 4: any other day, More moments": [
    row("4 Dec", unconfirmed, "2026-12-04T18:00:00Z", "more"),
    row("the last second of Friday", unconfirmed, "2026-12-04T23:59:59Z", "more"),
    row("7 Dec", unconfirmed, "2026-12-07T10:00:00Z", "more"),
    row("Monday 00:30, after a reception ending 01:30 on Sunday", confirmed, "2026-12-07T00:30:00Z", "more"),
    row("the same date a year later", unconfirmed, "2027-12-05T11:00:00Z", "more"),
    row("any time when there are no celebrations", [], "2026-12-05T11:00:00Z", "more"),
  ],
  "rule 5: with no capture time, the upload time": [
    row("no capture time and an upload on 5 Dec at 15:00 is the reception", unconfirmed, null, "reception", "2026-12-05T15:00:00Z"),
    row("no capture time and an upload on Sunday is the thanksgiving", unconfirmed, null, "thanks", "2026-12-06T14:00:00Z"),
    row("no capture time and an upload after the weekend is More moments", unconfirmed, null, "more", "2026-12-08T09:00:00Z"),
    row("a capture time wins over the upload time", unconfirmed, "2026-12-04T18:00:00Z", "more", "2026-12-05T15:00:00Z"),
    row("an unreadable capture time counts as none", unconfirmed, "not a date", "reception", "2026-12-05T15:00:00Z"),
    row("with neither time readable, More moments", unconfirmed, null, "more", "not a date"),
  ],
  "the weekend's days come from the celebrations' own dates": [
    row("moved a week later, 12 Dec 08:00 is the white wedding", movedAWeek, "2026-12-12T08:00:00Z", "ceremony"),
    row("moved a week later, 12 Dec 18:00 is the reception", movedAWeek, "2026-12-12T18:00:00Z", "reception"),
    row("moved a week later, 13 Dec 20:00 is the thanksgiving", movedAWeek, "2026-12-13T20:00:00Z", "thanks"),
    row("moved a week later, the old Saturday is More moments", movedAWeek, "2026-12-05T11:00:00Z", "more"),
    row("moved a week later, the old Sunday is More moments", movedAWeek, "2026-12-06T10:30:00Z", "more"),
  ],
};

const rows = Object.values(table).flat();

function assign(tableRow: Row): EventId | "more" {
  const capturedAt = tableRow.capturedAt === null ? null : new Date(tableRow.capturedAt);
  return assignCelebration(capturedAt, new Date(tableRow.uploadedAt), tableRow.celebrations);
}

describe("assignCelebration", () => {
  for (const [rule, ruleRows] of Object.entries(table)) {
    describe(rule, () => {
      it.each(ruleRows)("$name", (tableRow) => {
        expect(assign(tableRow)).toBe(tableRow.expected);
      });
    });
  }
});

const entryPoint = fileURLToPath(new URL("./celebration.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Bundles a module the way the media worker's bundle is built (Task 8): esbuild, packages left external. */
function bundle(source: Pick<BuildOptions, "entryPoints" | "stdin">) {
  return build({
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
    // Loaded as nothing, so an image in the graph shows up in the metafile instead of failing the build.
    loader: { ".jpg": "empty", ".jpeg": "empty", ".png": "empty", ".webp": "empty", ".svg": "empty" },
    ...source,
  });
}

/** Runs an ES module in a fresh Node process with the given time zone, and returns what it printed. */
function runInTimeZone(program: string, timeZone: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd: projectRoot,
      env: { ...process.env, TZ: timeZone },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve(output);
      else reject(new Error(`node exited with ${exitCode}: ${errors}`));
    });
    child.stdin.end(program);
  });
}

describe("assignCelebration in a machine time zone that isn't Accra's", () => {
  // The test machine is often on UTC, where a local-time bug hides. Kiritimati is UTC+14 (5 Dec
  // 11:00 there is still 4 Dec in Accra) and Los Angeles UTC-8 (5 Dec 05:00 in Accra is 4 Dec there).
  it.each(["Pacific/Kiritimati", "America/Los_Angeles"])("gives every row the same answer under TZ=%s", async (timeZone) => {
    const runner = `
      import { assignCelebration } from "./celebration";
      const rows = ${JSON.stringify(rows)};
      const results = rows.map((tableRow) =>
        assignCelebration(
          tableRow.capturedAt === null ? null : new Date(tableRow.capturedAt),
          new Date(tableRow.uploadedAt),
          tableRow.celebrations,
        ),
      );
      const offsetMinutes = new Date(Date.UTC(2026, 11, 5, 12)).getTimezoneOffset();
      console.log(JSON.stringify({ offsetMinutes, results }));
    `;
    const built = await bundle({ stdin: { contents: runner, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" } });
    const printed = JSON.parse(await runInTimeZone(built.outputFiles[0].text, timeZone));
    // Proof the zone took: otherwise this test would pass without testing anything.
    expect(printed.offsetMinutes).not.toBe(0);
    expect(printed.results).toEqual(rows.map((tableRow) => tableRow.expected));
  });
});

describe("celebration.ts's imports", () => {
  it("reach no next/ module and no image, so the media worker can bundle it", async () => {
    const result = await bundle({ entryPoints: [entryPoint] });
    const modules = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((imported) => imported.path));
    const files = Object.keys(result.metafile.inputs);
    expect(modules.filter((path) => path === "next" || path.startsWith("next/") || path === "server-only")).toEqual([]);
    expect(files.filter((path) => /\.(jpe?g|png|webp|svg)$/i.test(path))).toEqual([]);
    expect(files.some((path) => path.endsWith("src/lib/media/celebration.ts"))).toBe(true);
  });
});
