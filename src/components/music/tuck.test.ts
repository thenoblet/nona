import { describe, expect, it } from "vitest";
import { openPill, pillShown, tuckReducer, type TuckEvent, type TuckState } from "./tuck";

const run = (start: TuckState, ...events: TuckEvent["type"][]) =>
  events.reduce((state, type) => tuckReducer(state, { type } as TuckEvent), start);

describe("tuckReducer", () => {
  it("tucks the pill into the round button and opens it again", () => {
    const tucked = run(openPill, "tuck");
    expect(tucked).toEqual({ tucked: true, peeking: false });
    expect(pillShown(tucked)).toBe(false);
    expect(run(tucked, "open")).toEqual(openPill);
  });

  it("peeks when a new song starts while tucked, then tucks itself back", () => {
    const peeking = run(openPill, "tuck", "songChanged");
    expect(peeking).toEqual({ tucked: true, peeking: true });
    expect(pillShown(peeking)).toBe(true);
    expect(run(peeking, "peekEnded")).toEqual({ tucked: true, peeking: false });
  });

  it("does nothing on a new song while the pill is open", () => {
    expect(run(openPill, "songChanged")).toBe(openPill);
    expect(run(openPill, "peekEnded")).toBe(openPill);
  });

  it("stays open when the guest touches the pill while it peeks", () => {
    const touched = run(openPill, "tuck", "songChanged", "touched");
    expect(touched).toEqual(openPill);
    // The peek's timer still ends, and leaves it open.
    expect(run(touched, "peekEnded")).toEqual(openPill);
  });

  it("ignores a touch when not peeking", () => {
    const tucked = run(openPill, "tuck");
    expect(run(tucked, "touched")).toBe(tucked);
  });

  it("restores what this browser remembered, without a peek", () => {
    expect(tuckReducer(openPill, { type: "restore", tucked: true })).toEqual({ tucked: true, peeking: false });
    expect(tuckReducer({ tucked: true, peeking: true }, { type: "restore", tucked: false })).toEqual(openPill);
  });
});
