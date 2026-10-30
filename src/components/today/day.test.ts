import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import type { ScheduleItem } from "@/lib/content/schema";
import { nowIndex } from "./day";

const defaultSchedule = contentDefaults.schedule;
const saturdayItem: ScheduleItem = { time: "10:00", title: "Wedding", place: "Church", day: "sat" };
const sundayItem: ScheduleItem = { time: "09:00", title: "Thanksgiving", place: "Church", day: "sun" };

describe("nowIndex", () => {
  it("keeps today's behaviour on the default schedule", () => {
    expect(nowIndex(defaultSchedule, false)).toBe(1);
    expect(nowIndex(defaultSchedule, true)).toBe(defaultSchedule.findIndex((item) => item.day === "sun"));
  });

  it("picks the Saturday item on Saturday and the Sunday item on Sunday", () => {
    const schedule = [saturdayItem, sundayItem];
    expect(nowIndex(schedule, false)).toBe(0);
    expect(nowIndex(schedule, true)).toBe(1);
  });

  it("never points outside the schedule", () => {
    const schedules: ScheduleItem[][] = [[saturdayItem], [sundayItem], [sundayItem, saturdayItem], defaultSchedule];
    for (const schedule of schedules) {
      for (const secondDay of [false, true]) {
        const index = nowIndex(schedule, secondDay);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(schedule.length);
      }
    }
  });

  it("returns -1 for an empty schedule", () => {
    expect(nowIndex([], false)).toBe(-1);
    expect(nowIndex([], true)).toBe(-1);
  });
});
