import * as moderation from "@/lib/media/moderation";
import type { ModerationOptions } from "@/lib/media/moderation";

/*
 * The moderation actions as a route or a server action runs them, for tests: each hands its
 * follow-ups (the manifest, R2 deletions, jobs) to the caller's after(), and these wait for them
 * before returning, so a test sees everything the action did.
 */

/** The action with its options filled in: its follow-ups run, and are awaited, as after() would run them once the response is sent. */
function settled<TArguments extends unknown[], TResult>(
  action: (...input: [...TArguments, ModerationOptions]) => Promise<TResult>,
): (...input: TArguments) => Promise<TResult> {
  return async (...input) => {
    const followUps: Promise<void>[] = [];
    const result = await action(...input, {
      defer: (task) => {
        followUps.push(task());
      },
    });
    await Promise.all(followUps);
    return result;
  };
}

export const hideMedia = settled(moderation.hideMedia);
export const unhideMedia = settled(moderation.unhideMedia);
export const moveMedia = settled(moderation.moveMedia);
export const setHighlight = settled(moderation.setHighlight);
export const retryProcessing = settled(moderation.retryProcessing);
export const deleteMediaPermanently = settled(moderation.deleteMediaPermanently);
export const hideWish = settled(moderation.hideWish);
export const unhideWish = settled(moderation.unhideWish);
export const deleteWishPermanently = settled(moderation.deleteWishPermanently);
