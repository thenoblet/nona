import "server-only";
import type { Wish, WishInput } from "./types";

/**
 * STUB. Sample wishes plus anything sent while the server runs.
 * Later: a Postgres table, with voice and video files in S3.
 */
const wishes: Wish[] = [
  {
    id: "w1",
    kind: "text",
    message: "[May your home always be full of laughter, good food and the people who love you.]",
    signedAs: "[Guest's name]",
    createdAt: "2026-12-05T18:20:00Z",
  },
  { id: "w2", kind: "voice", duration: "[0:24]", signedAs: "[Guest's name]", createdAt: "2026-12-05T18:10:00Z" },
  {
    id: "w3",
    kind: "text",
    message: "[We watched you go from classmates to forever. God bless this union.]",
    signedAs: "[Guest's name]",
    createdAt: "2026-12-05T18:00:00Z",
  },
  { id: "w4", kind: "video", duration: "[0:30]", signedAs: "[Guest's name]", createdAt: "2026-12-05T17:45:00Z" },
  {
    id: "w5",
    kind: "text",
    message:
      "[A longer wish from a guest. The wall keeps each one in their own words and signature, exactly as they left it on the night.]",
    signedAs: "[Guest's name]",
    createdAt: "2026-12-05T17:30:00Z",
  },
  {
    id: "w6",
    kind: "text",
    message: "[Delicate as lace, tough as polished steel. Nancy, he chose well. Noblet, so did she.]",
    signedAs: "[Guest's name]",
    createdAt: "2026-12-05T17:15:00Z",
  },
  { id: "w7", kind: "text", message: "[Short and sweet.]", signedAs: "[Guest's name]", createdAt: "2026-12-05T17:00:00Z" },
  {
    id: "w8",
    kind: "text",
    message: "[Thank you for letting us share the most beautiful weekend. Here's to forever.]",
    signedAs: "[Guest's name]",
    createdAt: "2026-12-05T16:45:00Z",
  },
];

export async function listWishes(): Promise<Wish[]> {
  return [...wishes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addWish(input: WishInput): Promise<Wish> {
  const wish: Wish = {
    id: `w${Date.now()}`,
    kind: input.kind,
    message: input.message,
    signedAs: input.signedAs,
    createdAt: new Date().toISOString(),
  };
  wishes.unshift(wish);
  console.info("[stub] wish saved", { by: wish.signedAs, kind: wish.kind });
  return wish;
}
