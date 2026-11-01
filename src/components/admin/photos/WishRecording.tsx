import type { AdminWish } from "@/lib/media/admin-item";
import { clockTime } from "@/lib/media/album-item";

/**
 * A voice or video wish's recording in the admin's Wishes tab (Task 16): once media.wish has made
 * it, the couple play the file the wall plays, right there (preload="none": nothing is fetched until
 * they press play); its original opens in a new tab through their own 15-minute link either way
 * (while it is being made, after it failed, or once hidden, when its played file is withdrawn).
 */
export function WishRecording({ wish }: { wish: AdminWish }) {
  const { recording } = wish;
  if (!recording) return null;
  const what = wish.kind === "video" ? "Video message" : "Voice note";
  const label = `${what} from ${wish.signedAs}`;
  return (
    <span className="admin-wish-recording">
      {recording.url && wish.kind === "video" ? (
        <video
          className="admin-wish-video"
          src={recording.url}
          poster={recording.poster ?? undefined}
          controls
          playsInline
          preload="none"
          aria-label={label}
        />
      ) : recording.url ? (
        <audio className="admin-wish-audio" src={recording.url} controls preload="none" aria-label={label} />
      ) : null}
      <span className="admin-wish-body">
        {what}
        {recording.seconds !== null ? ` · ${clockTime(recording.seconds)}` : ""}
      </span>
      <a className="admin-linkbtn" href={`/admin/photos/original/${recording.mediaId}`} target="_blank" rel="noopener noreferrer">
        Open original
      </a>
    </span>
  );
}
