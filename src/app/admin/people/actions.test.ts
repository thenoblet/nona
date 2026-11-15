import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAccessError } from "@/lib/admin/access";
import { addViewer, isViewer, listViewers } from "@/lib/data/admin-viewers";
import { resetDb } from "../../../../test/db";

const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: cache.refresh, updateTag: vi.fn(), cacheTag: vi.fn(), cacheLife: vi.fn() }));

// The real access check, signed in through the dev stand-in as whoever a test says.
import { addViewerAction, removeViewerAction } from "./actions";

function emailForm(email: string): FormData {
  const form = new FormData();
  form.set("email", email);
  return form;
}

beforeEach(async () => {
  await resetDb();
  cache.refresh.mockClear();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ADMIN_COUPLE_EMAILS", "noblet@example.com,nancy@example.com");
  vi.stubEnv("ADMIN_DEV_EMAIL", "noblet@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("addViewerAction", () => {
  it("adds a viewer, saying who added them, and re-renders the page", async () => {
    const result = await addViewerAction(emailForm("  Ama@Example.com "));
    expect(result).toEqual({ ok: true, message: expect.stringContaining("Added ama@example.com") });
    expect(await isViewer("ama@example.com")).toBe(true);
    expect((await listViewers()).current[0]).toMatchObject({ email: "ama@example.com", addedBy: "noblet@example.com" });
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("refuses an address that isn't one, someone already a viewer, and the couple", async () => {
    for (const email of ["", "ama", "ama@", "ama example.com"]) {
      expect(await addViewerAction(emailForm(email))).toEqual({ ok: false, error: "Enter an email address like name@example.com" });
    }
    await addViewerAction(emailForm("ama@example.com"));
    expect(await addViewerAction(emailForm("AMA@example.com"))).toEqual({ ok: false, error: "ama@example.com is already a viewer." });
    expect(await addViewerAction(emailForm("Nancy@example.com"))).toMatchObject({ ok: false, error: expect.stringContaining("one of the couple's") });
    expect((await listViewers()).current).toHaveLength(1);
  });

  it("is the couple's alone: a viewer, or someone the admin doesn't know, gets nothing", async () => {
    await addViewer("ama@example.com", "noblet@example.com");
    for (const email of ["ama@example.com", "stranger@example.com"]) {
      vi.stubEnv("ADMIN_DEV_EMAIL", email);
      await expect(addViewerAction(emailForm("kofi@example.com"))).rejects.toBeInstanceOf(AdminAccessError);
    }
    expect(await isViewer("kofi@example.com")).toBe(false);
  });
});

describe("removeViewerAction", () => {
  it("removes a viewer, keeping who removed them, and re-renders the page", async () => {
    const added = await addViewer("ama@example.com", "noblet@example.com");
    if (added.status !== "added") throw new Error("not added");
    vi.stubEnv("ADMIN_DEV_EMAIL", "nancy@example.com");
    expect(await removeViewerAction(added.viewer.id)).toMatchObject({ ok: true });
    expect(await isViewer("ama@example.com")).toBe(false);
    expect((await listViewers()).removed[0]).toMatchObject({ email: "ama@example.com", removedBy: "nancy@example.com" });
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("says so when the viewer is already gone or the id isn't one", async () => {
    expect(await removeViewerAction(randomUUID())).toMatchObject({ ok: false, error: expect.stringContaining("already removed") });
    expect(await removeViewerAction("not-an-id")).toMatchObject({ ok: false, error: expect.stringContaining("isn't on the list") });
  });

  it("is the couple's alone: a viewer can't remove anyone, themselves included", async () => {
    const added = await addViewer("ama@example.com", "noblet@example.com");
    if (added.status !== "added") throw new Error("not added");
    vi.stubEnv("ADMIN_DEV_EMAIL", "ama@example.com");
    await expect(removeViewerAction(added.viewer.id)).rejects.toBeInstanceOf(AdminAccessError);
    expect(await isViewer("ama@example.com")).toBe(true);
  });
});
