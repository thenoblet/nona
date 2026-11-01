import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting } from "@/lib/data/settings";
import { resetDb } from "../../../test/db";
import {
  environmentSlideshowDelaySeconds,
  getSlideshowDelaySeconds,
  isSlideshowDelay,
  readSlideshowDelay,
  SLIDESHOW_DELAY_DEFAULT_SECONDS,
  SLIDESHOW_DELAY_MAX_SECONDS,
} from "./slideshow-delay";

// Against the test database (docker compose up -d db).

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the TV delay", () => {
  it("takes whole seconds from 0 to 900 only", () => {
    expect(SLIDESHOW_DELAY_MAX_SECONDS).toBe(900);
    for (const seconds of [0, 1, 180, 900]) expect(isSlideshowDelay(seconds)).toBe(true);
    for (const value of [-1, 901, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "180", null, undefined, true]) {
      expect(isSlideshowDelay(value)).toBe(false);
    }
  });

  it("is SLIDESHOW_DELAY_SECONDS while nothing is saved, read when asked, and 180 when that isn't set or isn't a delay", async () => {
    expect(SLIDESHOW_DELAY_DEFAULT_SECONDS).toBe(180);
    vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "");
    expect(await getSlideshowDelaySeconds()).toBe(180);
    vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "0");
    expect(await getSlideshowDelaySeconds()).toBe(0);
    vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "240");
    expect(await getSlideshowDelaySeconds()).toBe(240);
    expect(await readSlideshowDelay()).toEqual({ seconds: 240, saved: false, defaultSeconds: 240 });
    for (const wrong of ["901", "-5", "2.5", "soon", "1e2"]) {
      expect(environmentSlideshowDelaySeconds({ SLIDESHOW_DELAY_SECONDS: wrong })).toBe(180);
    }
    expect(environmentSlideshowDelaySeconds({})).toBe(180);
  });

  it("is the admin's saved value once there is one, whatever the environment says", async () => {
    vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "240");
    await setSetting("slideshow_delay_seconds", 30);
    expect(await getSlideshowDelaySeconds()).toBe(30);
    expect(await readSlideshowDelay()).toEqual({ seconds: 30, saved: true, defaultSeconds: 240 });
    await setSetting("slideshow_delay_seconds", 0);
    expect(await getSlideshowDelaySeconds()).toBe(0);
  });

  it("falls back to the environment's for a saved value that isn't a delay", async () => {
    vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "120");
    await setSetting("slideshow_delay_seconds", 5000);
    expect(await readSlideshowDelay()).toEqual({ seconds: 120, saved: false, defaultSeconds: 120 });
  });
});
