import { describe, expect, it } from "vitest";
import { getAt, groupNeighbour, insertAt, moveItem, moveWithinGroup, pathKey, removeAt, setAt } from "./editing";

describe("editing helpers", () => {
  const original = { church: { name: "Old", coords: { lat: 7, lng: -2 } }, list: ["a", "b", "c"] };

  it("reads a value at a path", () => {
    expect(getAt(original, ["church", "coords", "lat"])).toBe(7);
    expect(getAt(original, ["list", 1])).toBe("b");
    expect(getAt(original, ["hotel", "coords", "lat"])).toBeUndefined();
    expect(getAt("plain", [])).toBe("plain");
  });

  it("sets a value without changing the original, keeping everything else", () => {
    const edited = setAt(original, ["church", "name"], "New") as typeof original;
    expect(edited).toEqual({ ...original, church: { ...original.church, name: "New" } });
    expect(original.church.name).toBe("Old");
    expect(edited.list).toBe(original.list);
  });

  it("creates the objects on the way to a new value", () => {
    expect(setAt({ hotel: { name: "Inn" } }, ["hotel", "coords", "lat"], "7.1")).toEqual({
      hotel: { name: "Inn", coords: { lat: "7.1" } },
    });
  });

  it("sets an item in a list, and the list itself at the root", () => {
    expect(setAt(["a", "b"], [1], "B")).toEqual(["a", "B"]);
    expect(setAt(["a"], [], ["z"])).toEqual(["z"]);
  });

  it("inserts, removes and moves list items without changing the original", () => {
    const list = ["a", "b", "c"];
    expect(insertAt(list, 3, "d")).toEqual(["a", "b", "c", "d"]);
    expect(removeAt(list, 1)).toEqual(["a", "c"]);
    expect(moveItem(list, 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(list, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 0, -1)).toEqual(list);
    expect(moveItem(list, 2, 3)).toEqual(list);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("names a path the way the store's messages do", () => {
    expect(pathKey([0, "startTime"])).toBe("0.startTime");
    expect(pathKey(["hotel", "coords", "lat"])).toBe("hotel.coords.lat");
    expect(pathKey([])).toBe("");
  });
});

describe("moving within a group", () => {
  // A list of two groups, as the order of the day by celebration: a1, b1, a2, b2, a3.
  const list = ["a1", "b1", "a2", "b2", "a3"];
  const groupA = [0, 2, 4];

  it("finds the next item up or down in the same group, and none at its edges", () => {
    expect(groupNeighbour(groupA, 2, -1)).toBe(0);
    expect(groupNeighbour(groupA, 2, 1)).toBe(4);
    expect(groupNeighbour(groupA, 0, -1)).toBeUndefined();
    expect(groupNeighbour(groupA, 4, 1)).toBeUndefined();
  });

  it("moves an item past its group neighbour, leaving the other group in order", () => {
    expect(moveWithinGroup(list, groupA, 2, -1)).toEqual(["a2", "a1", "b1", "b2", "a3"]);
    expect(moveWithinGroup(list, groupA, 2, 1)).toEqual(["a1", "b1", "b2", "a3", "a2"]);
  });

  it("changes nothing at the group's edge", () => {
    expect(moveWithinGroup(list, groupA, 0, -1)).toEqual(list);
    expect(moveWithinGroup(list, groupA, 4, 1)).toEqual(list);
  });
});
