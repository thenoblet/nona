import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { wishes } from "@/lib/db/schema";
import { resetDb } from "../../../test/db";
import { addWish, listWishes } from "./wishes";

beforeEach(resetDb);

/** Moves a wish's sending time back, as if it had been sent that many minutes ago. */
async function sentMinutesAgo(id: string, minutes: number): Promise<void> {
  await getDb().execute(sql`update wishes set created_at = now() - make_interval(mins => ${minutes}) where id = ${id}`);
}

describe("addWish", () => {
  it("keeps a written wish in Postgres, with its words, signature and time", async () => {
    const sent = await addWish({ kind: "text", message: "Long life and happiness.", signedAs: "Ama" });

    const [row] = await getDb().select().from(wishes).where(eq(wishes.id, sent.id));
    expect(row).toMatchObject({ kind: "text", message: "Long life and happiness.", signedAs: "Ama" });
    expect(row.hiddenAt).toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(sent).toEqual({
      id: row.id,
      kind: "text",
      message: "Long life and happiness.",
      signedAs: "Ama",
      createdAt: row.createdAt.toISOString(),
    });
  });

  it("refuses a written wish without words", async () => {
    await expect(addWish({ kind: "text", signedAs: "Ama" })).rejects.toThrow();
  });

  it("refuses a voice or video wish without its recording", async () => {
    await expect(addWish({ kind: "voice", signedAs: "Ama" })).rejects.toThrow();
    await expect(addWish({ kind: "video", signedAs: "Ama" })).rejects.toThrow();
  });
});

describe("listWishes", () => {
  it("lists the wishes newest first", async () => {
    const first = await addWish({ kind: "text", message: "First", signedAs: "Kofi" });
    const second = await addWish({ kind: "text", message: "Second", signedAs: "Esi" });
    const third = await addWish({ kind: "text", message: "Third", signedAs: "Yaw" });
    await sentMinutesAgo(first.id, 30);
    await sentMinutesAgo(second.id, 10);

    const listed = await listWishes();
    expect(listed.map((wish) => wish.message)).toEqual(["Third", "Second", "First"]);
    expect(listed[0]).toEqual(third);
  });

  it("leaves out a hidden wish and a deleted one", async () => {
    const kept = await addWish({ kind: "text", message: "Kept", signedAs: "Kofi" });
    const hidden = await addWish({ kind: "text", message: "Hidden", signedAs: "Esi" });
    const deleted = await addWish({ kind: "text", message: "Deleted", signedAs: "Yaw" });
    await getDb()
      .update(wishes)
      .set({ hiddenAt: new Date(), hiddenBy: "admin@example.com" })
      .where(eq(wishes.id, hidden.id));
    await getDb().update(wishes).set({ deletedAt: new Date() }).where(eq(wishes.id, deleted.id));

    expect((await listWishes()).map((wish) => wish.id)).toEqual([kept.id]);
  });

  it("is empty when no one has written yet", async () => {
    expect(await listWishes()).toEqual([]);
  });
});
