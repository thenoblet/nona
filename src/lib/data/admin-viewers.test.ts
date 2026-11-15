import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../../test/db";
import { addViewer, isViewer, listViewers, removeViewer } from "./admin-viewers";

beforeEach(async () => {
  await resetDb();
});

describe("admin viewers", () => {
  it("adds an email trimmed and lowercased, so it matches however Access spells it", async () => {
    const result = await addViewer("  Ama.Owusu@Example.com ", "noblet@example.com");
    expect(result).toMatchObject({ status: "added", viewer: { email: "ama.owusu@example.com", addedBy: "noblet@example.com", removedAt: null } });
    expect(await isViewer("AMA.OWUSU@example.com")).toBe(true);
    expect(await isViewer("kofi@example.com")).toBe(false);
  });

  it("keeps one current row per email", async () => {
    await addViewer("ama@example.com", "noblet@example.com");
    expect(await addViewer("AMA@example.com", "nancy@example.com")).toEqual({ status: "already-viewer" });
    expect((await listViewers()).current).toHaveLength(1);
  });

  it("removes access but keeps the row, who removed it and when", async () => {
    const added = await addViewer("ama@example.com", "noblet@example.com");
    if (added.status !== "added") throw new Error("not added");
    expect(await removeViewer(added.viewer.id, "nancy@example.com")).toBe("removed");
    expect(await isViewer("ama@example.com")).toBe(false);
    const { current, removed } = await listViewers();
    expect(current).toEqual([]);
    expect(removed).toEqual([expect.objectContaining({ email: "ama@example.com", removedBy: "nancy@example.com" })]);
    expect(removed[0].removedAt).not.toBeNull();
    // Removing again, or someone who was never there, changes nothing.
    expect(await removeViewer(added.viewer.id, "noblet@example.com")).toBe("not-found");
    expect(await removeViewer(randomUUID(), "noblet@example.com")).toBe("not-found");
  });

  it("lets someone removed be added again, with the old row kept", async () => {
    const first = await addViewer("ama@example.com", "noblet@example.com");
    if (first.status !== "added") throw new Error("not added");
    await removeViewer(first.viewer.id, "noblet@example.com");
    expect(await addViewer("ama@example.com", "nancy@example.com")).toMatchObject({ status: "added" });
    expect(await isViewer("ama@example.com")).toBe(true);
    const { current, removed } = await listViewers();
    expect(current.map((viewer) => viewer.addedBy)).toEqual(["nancy@example.com"]);
    expect(removed).toHaveLength(1);
  });
});
