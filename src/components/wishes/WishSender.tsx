"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sendRecordedWish } from "@/app/(site)/wishes/actions";
import { Icon } from "@/components/ui/Icon";
import { MorphText } from "@/components/album/UploadCards";
import type { Engine } from "@/components/album/uploader/engine";
import { loadEngineForPick } from "@/components/album/uploader/load";
import { cameraCaption, createUploadStore, UPLOAD_WORDS, type UploadFailure, type UploadStore } from "@/components/album/uploader/state";
import { linkWish } from "./link-wish";
import type { Take } from "./recorder-machine";
import type { RecordedKind } from "./recording";

/*
 * Sending a recorded wish (gate B 4c, Ruling BU), loaded with the recorder: the recording goes up
 * through the album's own upload client (purpose `wish`), in gate A's honest steps: the bar follows
 * the real upload, "Retrying, keep this page open" while the connection drops and it carries on by
 * itself, "Checking it arrived safely" at 100%. Only once the server has verified the recording,
 * and then made the wish of it (sendRecordedWish), does the card turn to "Sent to the wall", and
 * the composer to its thank-you. Nothing about the recording is kept on the phone afterwards
 * (storage: none): a recording can't be picked again after a reload, so there is nothing to resume.
 */

export type WishSenderProps = {
  kind: RecordedKind;
  take: Take;
  signedAs: string;
  onSent: (sent: { id: string; signedAs: string }) => void;
  /** Back to recording afresh, when this one can't be sent. */
  onRecordAgain: () => void;
};

/** How long "Sent to the wall" shows before the thank-you. */
const SENT_SHOWS_MILLISECONDS = 1_100;

type Linking = { phase: "waiting" } | { phase: "linking" } | { phase: "done" } | { phase: "failed"; failure: UploadFailure };

/** The card's own store, with the recording on it: purpose wish, a video's picture as its preview. */
function storeWith(kind: RecordedKind, file: File): { store: UploadStore; itemId: string | null } {
  const store = createUploadStore({
    purpose: "wish",
    // Only a video's picture is worth a preview; a voice note shows a microphone.
    previews: { create: (picked) => (kind === "video" ? URL.createObjectURL(picked) : null), revoke: (url) => URL.revokeObjectURL(url) },
    // The card is this one item's: it never tidies away while the guest watches it.
    tidy: { cameraMs: 24 * 60 * 60 * 1000, batchMs: 24 * 60 * 60 * 1000 },
  });
  store.add([file], kind === "video" ? "video" : "photo");
  return { store, itemId: store.getSnapshot().items[0]?.id ?? null };
}

export default function WishSender({ kind, take, signedAs, onSent, onRecordAgain }: WishSenderProps) {
  const [{ store, itemId }] = useState(() => storeWith(kind, take.file));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const engine = useRef<Engine | null>(null);
  const linkStarted = useRef(false);
  const [linking, setLinking] = useState<Linking>({ phase: "waiting" });
  const [engineFailed, setEngineFailed] = useState(false);

  /** Makes the wish of the arrived recording, once at a time. */
  const link = useCallback(
    async (mediaId: string) => {
      setLinking({ phase: "linking" });
      const state = await linkWish({ kind, mediaId, signedAs }, sendRecordedWish);
      if (state.status === "sent") {
        setLinking({ phase: "done" });
        setTimeout(() => onSent(state.sent), SENT_SHOWS_MILLISECONDS);
      } else if (state.status === "refused") {
        setLinking({ phase: "failed", failure: { reason: "We couldn't send this wish", hint: state.message, canRetry: false } });
      } else if (state.status === "error") {
        setLinking({ phase: "failed", failure: { reason: "Your wish didn't send", hint: state.message, canRetry: true } });
      }
    },
    [kind, signedAs, onSent],
  );

  // Once: the upload client takes the recording; and the moment the server has it, the wish is made.
  useEffect(() => {
    if (itemId && store.get(itemId)?.status === "queued" && !engine.current) {
      loadEngineForPick().then(
        ({ startEngine }) => {
          if (engine.current) return;
          engine.current = startEngine(store, { purpose: "wish", guestName: () => signedAs, onPersonalLink: () => {} }, { storage: null });
          engine.current.pump();
        },
        () => setEngineFailed(true),
      );
    }
    const arrived = () => {
      const item = itemId ? store.get(itemId) : undefined;
      if (item?.status !== "added" || !item.mediaId || linkStarted.current) return;
      linkStarted.current = true;
      void link(item.mediaId);
    };
    return store.subscribe(arrived);
  }, [store, itemId, signedAs, link]);

  const item = snapshot.items.find((candidate) => candidate.id === itemId) ?? null;
  const mediaId = item?.status === "added" ? item.mediaId : null;

  const failure: UploadFailure | null = engineFailed
    ? { reason: UPLOAD_WORDS.notSent, hint: "Check the connection, then try again.", canRetry: false }
    : linking.phase === "failed"
      ? linking.failure
      : (item?.failure ?? null);
  const done = linking.phase === "done";
  const status = failure ? "failed" : done ? "added" : (item?.status ?? "queued");
  const percent = done ? 100 : (item?.percent ?? 0);
  const caption = failure
    ? failure.hint
    : done
      ? "Everyone will see it in a moment"
      : item?.status === "added"
        ? "Checking it arrived safely"
        : item
          ? cameraCaption(item, snapshot.notice, snapshot.timeLeft)
          : "Keep this page open for a moment";
  const title = failure ? failure.reason : done ? "Sent to the wall" : "Sending your wish";

  function tryAgain() {
    if (linking.phase === "failed" && mediaId) {
      void link(mediaId);
      return;
    }
    if (itemId) engine.current?.retry(itemId);
  }

  return (
    <div className="flex flex-col gap-3 pt-1 pb-0.5" aria-live="polite" data-wish-send={status}>
      <div className="flex items-center gap-3">
        <span data-status={status} className="relative -mb-1.5 size-[62px] shrink-0">
          {kind === "video" && item?.previewUrl ? (
            <video
              src={`${item.previewUrl}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              aria-hidden
              className="absolute inset-[0_6px_6px_0] size-14 rounded-[3px] bg-tile object-cover"
            />
          ) : (
            <span className="absolute inset-[0_6px_6px_0] grid size-14 place-items-center rounded-[3px] bg-halo text-ember">
              <Icon name={kind === "video" ? "video" : "mic"} size={22} />
            </span>
          )}
          <span className="upload-badge size-5.5">
            {status === "failed" ? (
              <Icon name="alert" size={12} strokeWidth={2.6} />
            ) : status === "retrying" ? (
              <Icon name="retry" size={12} strokeWidth={2.2} className="upload-retry" />
            ) : (
              <>
                <span className="upload-spinner" />
                <Icon name="check" size={12} strokeWidth={2.4} className="upload-tick" />
              </>
            )}
          </span>
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 font-serif text-[21px] leading-[1.2] italic">
            <MorphText text={title} />
          </p>
          {caption ? <p className="m-0 text-xs leading-[1.45] text-mocha">{caption}</p> : null}
        </div>
      </div>
      {failure ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 pl-[74px]">
          {failure.canRetry ? (
            <button type="button" onClick={tryAgain} className="ember-link inline-flex min-h-11 cursor-pointer items-center text-xs tracking-[0.18em] uppercase">
              Try again
            </button>
          ) : null}
          <button type="button" onClick={onRecordAgain} className="ember-link inline-flex min-h-11 cursor-pointer items-center text-xs tracking-[0.18em] uppercase">
            Record again
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <div
            role="progressbar"
            aria-label="Sending your wish"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-tray"
          >
            <div
              className={`h-full rounded-[inherit] transition-[width,background-color] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] ${status === "retrying" ? "bg-stone" : "bg-ember"}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="min-w-[4ch] text-right text-xs font-medium text-mocha tabular-nums">{percent}%</span>
        </div>
      )}
    </div>
  );
}
