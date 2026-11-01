import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeStorage, seedMoment, testSql } from "./media-seed";

/*
 * The home page after the wedding counts the album's real moments (Task 20): what everyone sees in
 * the album, and how many guests shared them, never a placeholder.
 */

const sql = testSql();
const madeHere: string[] = [];

async function guest(name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into guests (id, display_name, link_token) values (${id}, ${name}, ${`e2e-home-${id}`})`;
  return id;
}

async function moment(options: Parameters<typeof seedMoment>[1]): Promise<string> {
  const { id } = await seedMoment(sql, options);
  madeHere.push(id);
  return id;
}

test.beforeEach(async () => {
  await sql`delete from upload_events`;
  await sql`delete from media where purpose = 'album'`;
});

test.afterAll(async () => {
  await sql`delete from media where id = any(${madeHere})`;
  await sql.end();
  closeStorage();
});

test("after the wedding, the home page counts the album's visible photos and videos and the guests who shared them", async ({ page }) => {
  const [ama, kojo, efua] = [await guest("Ama"), await guest("Kojo"), await guest("Efua")];
  await moment({ index: 0, secondsAgo: 60, guestId: ama });
  await moment({ index: 1, secondsAgo: 120, guestId: ama, kind: "video" });
  await moment({ index: 2, secondsAgo: 180, guestId: kojo });
  await moment({ index: 3, secondsAgo: 240, guestId: kojo, celebration: "ceremony" });
  // Efua's: hidden by the couple, removed by her, a failed upload and a wish's recording, none of
  // which the album shows, so none counts and neither does she.
  const hidden = await moment({ index: 4, secondsAgo: 300, guestId: efua });
  const removed = await moment({ index: 5, secondsAgo: 300, guestId: efua });
  const failed = await moment({ index: 6, secondsAgo: 300, guestId: efua });
  const wish = await moment({ index: 7, secondsAgo: 300, guestId: efua, kind: "video" });
  await sql`update media set hidden_at = now(), hidden_by = 'couple@example.com' where id = ${hidden}`;
  await sql`update media set hidden_at = now(), hidden_by = 'uploader', removed_by_uploader = true where id = ${removed}`;
  await sql`update media set status = 'failed', failure_reason = 'corrupt', listed_at = null where id = ${failed}`;
  await sql`update media set purpose = 'wish' where id = ${wish}`;

  await page.goto("/home?mode=after");
  const album = page.locator("section#album").filter({ visible: true });
  // Visible only: until the streamed section swaps in, a hidden copy of it can sit beside it.
  await expect(album.getByText("3 photos and 1 video from 2 of you, all in one place.").filter({ visible: true })).toBeVisible();
  // The album beneath it counts the same moments.
  await expect(album.getByText("4 moments").filter({ visible: true })).toBeVisible();
  expect(await album.innerText()).not.toMatch(/\[[^\]]*\]/);
});

test("after the wedding, an empty album says what it will hold rather than count nothing", async ({ page }) => {
  await page.goto("/home?mode=after");
  const album = page.locator("section#album").filter({ visible: true });
  await expect(album.getByText("Every photo and video you share, all in one place.").filter({ visible: true })).toBeVisible();
  expect(await album.innerText()).not.toMatch(/\[[^\]]*\]/);
});
