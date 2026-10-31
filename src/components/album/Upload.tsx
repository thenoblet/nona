"use client";

import { createContext, use, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from "react";
import { Halo } from "@/components/ui/Halo";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ALBUM_PICKER_ACCEPT } from "@/lib/media/limits";
import { readGuestName } from "./guestName";
import { PersonalLinkOffer } from "./PersonalLinkOffer";
import { BatchCard, CameraCard } from "./UploadCards";
import type { Engine } from "./uploader/engine";
import { loadEngineForPick, prefetchEngineWhenIdle } from "./uploader/load";
import { setPersonalLink, useLinkOfferHidden, usePersonalLink } from "./uploader/personal-link";
import { createUploadStore, UPLOAD_WORDS, type UploadSnapshot, type UploadSource, type UploadStore } from "./uploader/state";

/*
 * The album's share buttons and the cards under its header. The store (uploader/state.ts) ships
 * with the page, so a pick shows at once; the uploader itself (uploader/engine.ts, with Uppy) is
 * its own chunk, fetched while the page is idle and loaded for certain on the first pick.
 */

type CameraSource = Exclude<UploadSource, "gallery">;

type UploadControls = {
  snapshot: UploadSnapshot;
  start: (files: FileList, source: UploadSource) => void;
  retry: (itemId: string) => void;
  cancel: (itemId: string) => void;
  /** Remembers a camera input, so "Take another" can reopen the camera. */
  register: (source: CameraSource, input: HTMLInputElement | null) => void;
  reopen: (source: CameraSource) => void;
};

const UploadContext = createContext<UploadControls | null>(null);

function useUpload(): UploadControls {
  const controls = use(UploadContext);
  if (!controls) throw new Error("Album upload controls must sit inside <UploadProvider>.");
  return controls;
}

/** Shares the uploads between the share buttons and the cards under the header. */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [store] = useState<UploadStore>(() => createUploadStore());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const engine = useRef<Promise<Engine> | null>(null);
  const inputs = useRef<Partial<Record<CameraSource, HTMLInputElement | null>>>({});

  // Let go of the thumbnails' memory when the page goes.
  useEffect(
    () => () => {
      for (const item of store.getSnapshot().items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [store],
  );

  function loadedEngine(): Promise<Engine> {
    engine.current ??= loadEngineForPick()
      .then((module) => module.startEngine(store, { guestName: readGuestName, onPersonalLink: setPersonalLink }))
      .catch((error: unknown) => {
        engine.current = null;
        throw error;
      });
    return engine.current;
  }

  /** The uploader couldn't load (no connection yet): the waiting files say so, with Try again. */
  function engineMissing(itemIds: string[]): void {
    for (const itemId of itemIds) {
      store.update(itemId, {
        status: "failed",
        failure: { reason: UPLOAD_WORDS.connectionDropped, hint: null, canRetry: true },
      });
    }
  }

  const controls: UploadControls = {
    snapshot,
    start(files, source) {
      const queued = store.add(Array.from(files), source);
      if (queued.length === 0) return;
      loadedEngine().then(
        (loaded) => loaded.pump(),
        () => engineMissing(queued.map((item) => item.id)),
      );
    },
    retry(itemId) {
      if (engine.current) {
        void engine.current.then((loaded) => loaded.retry(itemId));
        return;
      }
      store.update(itemId, { status: "queued", failure: null });
      loadedEngine().then(
        (loaded) => loaded.pump(),
        () => engineMissing([itemId]),
      );
    },
    cancel(itemId) {
      if (engine.current) void engine.current.then((loaded) => loaded.cancel(itemId));
      // Nothing has reached the server before the uploader loads.
      else store.remove(itemId);
    },
    register(source, input) {
      inputs.current[source] = input;
    },
    reopen(source) {
      inputs.current[source]?.click();
    },
  };

  return <UploadContext value={controls}>{children}</UploadContext>;
}

const choices: Record<UploadSource, { icon: IconName; primary: string; secondary: string; accept: string }> = {
  photo: { icon: "camera", primary: "Take a photo", secondary: "Take a photo", accept: "image/*" },
  video: { icon: "video", primary: "Record a video", secondary: "Record video", accept: "video/*" },
  gallery: { icon: "image", primary: "Choose photos & videos", secondary: "From your phone", accept: ALBUM_PICKER_ACCEPT },
};

/**
 * One way to share: a label around a hidden file input, so the phone's own camera or gallery
 * opens natively. `capture` hands off to the camera app (full quality, no permission prompt, and
 * it works inside WhatsApp's browser). The gallery offers only the album's photo and video types.
 */
function PickButton({ source, primary = false, className = "" }: { source: UploadSource; primary?: boolean; className?: string }) {
  const { start, register } = useUpload();
  const choice = choices[source];

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) start(event.target.files, source);
    event.target.value = "";
  }

  const input = (
    <input
      ref={source === "gallery" ? undefined : (element) => register(source, element)}
      type="file"
      accept={choice.accept}
      capture={source === "gallery" ? undefined : "environment"}
      multiple={source === "gallery"}
      onChange={onChange}
      className="sr-only"
    />
  );
  const focus = "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-ember";

  if (primary) {
    return (
      <label
        className={`press flex min-h-16 w-full cursor-pointer items-center gap-3.5 rounded-full bg-ember py-2 pr-6 pl-2 text-[13px] font-medium uppercase tracking-[0.2em] text-cocoa shadow-[var(--shadow-pill-dark)] ${focus} ${className}`}
      >
        <Halo icon={choice.icon} tone="glass" size="lg" />
        {choice.primary}
        {input}
      </label>
    );
  }
  // Below 390 px the words space tighter, and at 340 px and under the icon makes way, so "From
  // your phone" fits its half of a 320 px phone.
  return (
    <label
      className={`press flex min-h-12 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-ember/55 px-3 text-[11px] whitespace-nowrap uppercase tracking-[0.12em] text-white transition-colors hover:bg-white/5 max-[390px]:gap-1.5 max-[390px]:px-2.5 max-[390px]:tracking-[0.06em] ${focus} ${className}`}
    >
      <Icon name={choice.icon} size={15} className="shrink-0 text-ember max-[341px]:hidden" />
      {choice.secondary}
      {input}
    </label>
  );
}

const touchOnly = "[@media(pointer:fine)]:hidden";
const fineOnly = "hidden [@media(pointer:fine)]:flex";

/**
 * The share buttons. On the wedding weekend the camera comes first; before and after, the gallery
 * does. Laptops have no camera to hand off to, so they get the gallery only. Once they show, the
 * uploader is fetched while the page is idle.
 */
export function ShareButtons({ cameraFirst }: { cameraFirst: boolean }) {
  useEffect(() => prefetchEngineWhenIdle(), []);
  return (
    <div className="flex flex-col gap-2">
      {cameraFirst ? (
        <>
          <PickButton source="photo" primary className={touchOnly} />
          <PickButton source="gallery" primary className={fineOnly} />
        </>
      ) : (
        <PickButton source="gallery" primary />
      )}
      <div className={`grid grid-cols-2 gap-2 ${touchOnly}`}>
        {cameraFirst ? (
          <>
            <PickButton source="video" />
            <PickButton source="gallery" />
          </>
        ) : (
          <>
            <PickButton source="photo" />
            <PickButton source="video" />
          </>
        )}
      </div>
    </div>
  );
}

/** Holds the buttons' space while the page works out which come first, and whether sharing is open. */
export function ShareButtonsSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      <div className="h-16 rounded-full bg-ember/35" />
      <div className={`grid grid-cols-2 gap-2 ${touchOnly}`}>
        <div className="h-12 rounded-full border border-ember/30" />
        <div className="h-12 rounded-full border border-ember/30" />
      </div>
    </div>
  );
}

/** The cards under the header: the camera card or the gallery batch, then the personal-link offer. */
export function UploadProgress() {
  const { snapshot, retry, cancel, reopen } = useUpload();
  const link = usePersonalLink();
  const offerHidden = useLinkOfferHidden();
  const { view, showLinkOffer } = snapshot;
  const offer = showLinkOffer && link !== null && !offerHidden;
  if (view.kind === "none" && !offer) return null;

  return (
    <div className="flex flex-col gap-3">
      {view.kind === "camera" ? (
        <CameraCard
          key={view.item.id}
          item={view.item}
          onRetry={() => retry(view.item.id)}
          onCancel={() => cancel(view.item.id)}
          onTakeAnother={() => reopen(view.item.source === "video" ? "video" : "photo")}
        />
      ) : view.kind === "batch" ? (
        <BatchCard view={view} onRetry={retry} onCancel={cancel} />
      ) : null}
      {offer ? <PersonalLinkOffer link={link} /> : null}
    </div>
  );
}
