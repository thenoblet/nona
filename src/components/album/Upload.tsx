"use client";

import {
  createContext,
  lazy,
  Suspense,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ComponentType,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { DockItem } from "@/components/music/Dock";
import { Halo } from "@/components/ui/Halo";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ALBUM_PICKER_ACCEPT } from "@/lib/media/limits";
import { readGuestName } from "./guestName";
import type { UploadCircle } from "./UploadCircle";
import { BatchCard, CameraCard, emberButton } from "./UploadCards";
import type { Engine } from "./uploader/engine";
import { readOnPick } from "./uploader/fingerprint";
import { loadEngine, loadEngineForPick, prefetchEngineWhenIdle } from "./uploader/load";
import {
  browserStorage,
  createPendingCancels,
  createReturnNoticeReader,
  dismissReturnNotice,
  subscribeToReturnNotice,
} from "./uploader/local-records";
import { setPersonalLink, useLinkOfferAllowed, usePersonalLink } from "./uploader/personal-link";
import {
  createUploadStore,
  returnNoticeWords,
  UPLOAD_WORDS,
  type UploadSnapshot,
  type UploadSource,
  type UploadStore,
} from "./uploader/state";

/*
 * The album's share buttons and the cards under its header. The store (uploader/state.ts) ships
 * with the page, so a pick shows at once, and each picked file is read for its fingerprint at once
 * (Ruling BA); the uploader itself (uploader/engine.ts, with Uppy) is its own chunk, fetched while
 * the page is idle and loaded for certain on the first pick. The personal-link offer is a chunk of
 * its own too: it shows only once a file has been added. While files send, the card can be
 * minimised to a floating circle in the dock (Ruling BE); back on the album with an upload that
 * didn't finish, a slim notice offers to carry it on.
 */

// A chunk that can't be fetched (the venue's network, or one a deploy removed) leaves the offer out:
// the album and the upload under way carry on.
const PersonalLinkOffer = lazy<ComponentType<{ link: string; onHidden?: () => void }>>(() =>
  import("./PersonalLinkOffer")
    .then((module) => ({ default: module.PersonalLinkOffer }))
    .catch(() => ({ default: NothingShown })),
);

function NothingShown(): null {
  return null;
}

type CameraSource = Exclude<UploadSource, "gallery">;

type UploadControls = {
  snapshot: UploadSnapshot;
  start: (files: FileList, source: UploadSource) => void;
  retry: (itemId: string) => void;
  cancel: (itemId: string) => void;
  dismiss: (itemId: string) => void;
  /** Remembers a camera input, so "Take another" can reopen the camera. */
  register: (source: CameraSource, input: HTMLInputElement | null) => void;
  reopen: (source: CameraSource) => void;
  /** A file that changed after it was picked: opens the gallery for it, and its pick takes the row's place (Ruling BA). */
  chooseAgain: (itemId: string) => void;
  /** Opens the gallery, for the notice on return. */
  chooseFiles: () => void;
  setMinimised: (minimised: boolean) => void;
  /** Whether the share buttons are showing: sharing is open, so an unfinished upload can carry on. */
  sharingOpen: boolean;
  setSharingOpen: (open: boolean) => void;
};

/** The gallery's file input the guest can see (its share button may be laid out twice), or null. */
function visibleGalleryInput(): HTMLInputElement | null {
  for (const input of document.querySelectorAll<HTMLInputElement>('main input[type="file"][multiple]')) {
    const label = input.closest("label");
    if (label && label.offsetParent !== null) return input;
  }
  return null;
}

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
  /** The changed file whose place the gallery's next pick takes (Ruling BA). */
  const replacing = useRef<string | null>(null);
  const [sharingOpen, setSharingOpen] = useState(false);

  function engineFrom(loader: typeof loadEngine): Promise<Engine> {
    engine.current ??= loader()
      .then((module) => module.startEngine(store, { guestName: readGuestName, onPersonalLink: setPersonalLink }))
      .catch((error: unknown) => {
        engine.current = null;
        throw error;
      });
    return engine.current;
  }

  // Let go of the thumbnails' memory when the page goes.
  useEffect(
    () => () => {
      for (const item of store.getSnapshot().items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [store],
  );

  // A Cancel an earlier visit couldn't get answered is sent again; only then is the uploader loaded.
  useEffect(() => {
    if (createPendingCancels(browserStorage()).list().length === 0) return;
    engineFrom(loadEngine)
      .then((loaded) => loaded.replayPendingCancels())
      .catch(() => {});
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const stale = source === "gallery" ? replacing.current : null;
      replacing.current = null;
      const queued = store.add(Array.from(files), source, { replacing: stale ?? undefined });
      // Read now, alongside the uploader loading and the guest call: the sooner a file is read, the
      // smaller the window for the phone to change it under the page (Ruling BA).
      for (const item of queued) readOnPick(item.file).catch(() => {});
      if (queued.length === 0) return;
      engineFrom(loadEngineForPick).then(
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
      engineFrom(loadEngineForPick).then(
        (loaded) => loaded.pump(),
        () => engineMissing([itemId]),
      );
    },
    cancel(itemId) {
      if (engine.current) void engine.current.then((loaded) => loaded.cancel(itemId));
      // Nothing has reached the server before the uploader loads.
      else store.remove(itemId);
    },
    dismiss(itemId) {
      if (engine.current) void engine.current.then((loaded) => loaded.dismiss(itemId));
      else store.remove(itemId);
    },
    register(source, input) {
      inputs.current[source] = input;
    },
    reopen(source) {
      inputs.current[source]?.click();
    },
    chooseAgain(itemId) {
      replacing.current = itemId;
      visibleGalleryInput()?.click();
    },
    chooseFiles() {
      replacing.current = null;
      visibleGalleryInput()?.click();
    },
    setMinimised(minimised) {
      store.setMinimised(minimised);
    },
    sharingOpen,
    setSharingOpen,
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
 * it works inside WhatsApp's browser). The gallery offers only photos and videos.
 */
function PickButton({
  source,
  primary = false,
  label,
  className = "",
}: {
  source: UploadSource;
  primary?: boolean;
  /** Words in place of the source's own. */
  label?: string;
  className?: string;
}) {
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
        {label ?? choice.primary}
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
      {label ?? choice.secondary}
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
  const { setSharingOpen } = useUpload();
  useEffect(() => prefetchEngineWhenIdle(), []);
  useEffect(() => {
    setSharingOpen(true);
    return () => setSharingOpen(false);
  }, [setSharingOpen]);
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

/**
 * Once the couple close sharing, for the 24 hours an upload started before may still finish: the
 * gallery, for this phone to finish what it started. The API takes only those.
 */
export function FinishSendingButton() {
  useEffect(() => prefetchEngineWhenIdle(), []);
  return <PickButton source="gallery" primary label="Finish sending what you started" />;
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

/**
 * Where focus goes next: to a row's own × once Try again has turned it back to sending; to the next
 * row once one has gone; to the card, or to the circle when the card is minimised.
 */
type FocusRequest =
  | { kind: "row-left"; itemId: string; position: number }
  | { kind: "retried"; itemId: string }
  | { kind: "card" }
  | { kind: "circle" };

/** The first share button on screen (its hidden input takes the focus), when there's no card left. */
function firstVisiblePicker(): HTMLElement | null {
  for (const input of document.querySelectorAll<HTMLInputElement>('main label input[type="file"]')) {
    const label = input.closest("label");
    if (label && label.offsetParent !== null) return input;
  }
  return null;
}

/** What the notice on return says, and of which uploads; null for nothing to say. */
type ReturnNoticeState = { words: string; mediaIds: string[] } | null;

let readReturnNotice: (() => ReturnNoticeState) | null = null;

/**
 * The notice on return, read again only when its records change (not on every render while files
 * send), as one unchanged value for React to compare.
 */
function returnNoticeSnapshot(): ReturnNoticeState {
  readReturnNotice ??= createReturnNoticeReader(browserStorage(), (uploads) => {
    const words = returnNoticeWords(uploads);
    return words ? { words, mediaIds: uploads.map((upload) => upload.mediaId) } : null;
  });
  return readReturnNotice();
}

/** Hears the notice on return's records change, and another tab's beat go stale. */
function subscribeToUnfinished(listener: () => void): () => void {
  return subscribeToReturnNotice(browserStorage(), listener);
}

/**
 * Back on the album with uploads this phone started and didn't finish (Ruling BE): what didn't
 * finish, and a Choose button; the same file chosen again carries on, skipping the parts sent. It
 * goes once those uploads finish (or are a week old, when R2 has let them go), or when the guest
 * sets it aside ("Not now"); another upload left unfinished brings it back.
 */
function ReturnNotice({ notice, onChoose }: { notice: NonNullable<ReturnNoticeState>; onChoose: () => void }) {
  return (
    <section
      aria-label="Didn't finish sending"
      data-return-notice
      className="flex animate-rise flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-paper)] bg-white py-3 pr-1.5 pl-4 shadow-[var(--shadow-paper)]"
    >
      <p className="m-0 min-w-[12rem] flex-1 pr-1 text-[13px] leading-[1.45] text-cocoa">{notice.words}</p>
      {/* Together, beside the words or on a line of their own on a narrow phone. */}
      <div className="ml-auto flex items-center">
        <button type="button" onClick={onChoose} className={emberButton}>
          Choose
        </button>
        <button
          type="button"
          onClick={() => dismissReturnNotice(notice.mediaIds, browserStorage())}
          aria-label="Not now"
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-mocha"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </section>
  );
}

/** The card and the floating circle share this name while one morphs into the other (Ruling BI). */
const MORPH_NAME = "upload-morph";
/** Noblet's gentle ease-in-out, slow enough to see: the glide, the rounding and what follows share it. */
const MORPH_MILLISECONDS = 550;
const MORPH_EASING = "cubic-bezier(0.65, 0, 0.35, 1)";
/**
 * What follows the card on the page, and glides with it rather than jumping: the personal-link
 * offer under the card, and the album below.
 */
const MORPH_FOLLOWERS: readonly [selector: string, name: string][] = [
  ["[data-link-offer]", "upload-morph-offer"],
  ["[data-upload-below]", "upload-morph-below"],
];

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void> };

/** Names (or, with "", unnames) what follows the card, as it now stands, and the dock. */
function nameFollowers(named: boolean): void {
  for (const [selector, name] of MORPH_FOLLOWERS) {
    const follower = document.querySelector<HTMLElement>(selector);
    if (follower) follower.style.viewTransitionName = named ? name : "";
  }
  // The music's dock is named too, so it stays painted above the album gliding beneath it.
  const dock = document.getElementById("dock-slot")?.parentElement;
  if (dock) dock.style.viewTransitionName = named ? "upload-morph-dock" : "";
}

/**
 * Ruling BI (Noblet: "the card turn into a circle smoothly and smoothly move to the bottom"): makes
 * `change` (minimising, or opening the card again) a shared-element morph between the element at
 * `fromSelector` and the one at `toSelector`, through the browser's view transitions. The change
 * runs in flushSync, so the new snapshot is the new state. The white shape glides and rounds on one
 * curve (MORPH_EASING over MORPH_MILLISECONDS, handed to globals.css too), the contents cross-fade
 * by direction, and what follows the card glides with it. Where the browser has no view
 * transitions, or the guest asked for less motion, the change simply happens.
 */
function morph(direction: "minimise" | "reopen", change: () => void, fromSelector: string, toSelector: string): void {
  const start = (document as unknown as { startViewTransition?: (update: () => void) => ViewTransitionLike }).startViewTransition;
  const from = document.querySelector<HTMLElement>(fromSelector);
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (typeof start !== "function" || reduced || !from) {
    change();
    return;
  }
  const root = document.documentElement;
  const radii = direction === "minimise" ? ["3px", "28px"] : ["28px", "3px"];
  let to: HTMLElement | null = null;
  let rounding: Animation | null = null;
  const tidyUp = () => {
    from.style.viewTransitionName = "";
    if (to) to.style.viewTransitionName = "";
    nameFollowers(false);
    delete root.dataset.uploadMorph;
    // Held at its end until now; left, it would cling to the next morph's shape of the same name.
    rounding?.cancel();
  };
  from.style.viewTransitionName = MORPH_NAME;
  nameFollowers(true);
  // The page beneath changes at once; only the card, the circle and what follows the card move.
  root.dataset.uploadMorph = direction;
  root.style.setProperty("--upload-morph-duration", `${MORPH_MILLISECONDS}ms`);
  root.style.setProperty("--upload-morph-easing", MORPH_EASING);
  try {
    const transition = start.call(document, () => {
      from.style.viewTransitionName = "";
      flushSync(change);
      nameFollowers(true);
      to = document.querySelector<HTMLElement>(toSelector);
      if (!to) return;
      to.style.viewTransitionName = MORPH_NAME;
      // It arrives by the morph: its own entrance (the card's rise, the circle's pop) is over already.
      for (const animation of to.getAnimations()) animation.finish();
    });
    transition.ready
      .then(() => {
        // The same curve and length as the glide (globals.css takes them from the custom properties above).
        rounding = root.animate(
          { borderRadius: radii },
          { duration: MORPH_MILLISECONDS, easing: MORPH_EASING, fill: "forwards", pseudoElement: `::view-transition-group(${MORPH_NAME})` },
        );
      })
      .catch(() => {});
    transition.finished.then(tidyUp, tidyUp);
  } catch {
    tidyUp();
    change();
  }
}

/**
 * The cards under the header: the notice on return, the camera card or the gallery batch (or, while
 * minimised, the floating circle in the dock), then the personal-link offer.
 */
export function UploadProgress() {
  const { snapshot, retry, cancel, dismiss, reopen, chooseAgain, chooseFiles, setMinimised, sharingOpen } = useUpload();
  const link = usePersonalLink();
  const offerAllowed = useLinkOfferAllowed();
  // The floating circle comes with the uploader's chunk, loaded by the time anything sends: until it
  // is here (or if it never arrives), the card simply offers no Minimise.
  const [Circle, setCircle] = useState<typeof UploadCircle | null>(null);
  const sending = snapshot.items.some((item) => item.status === "sending" || item.status === "retrying" || item.status === "confirming");
  useEffect(() => {
    if (!sending || Circle) return;
    let current = true;
    loadEngine().then(
      (module) => {
        if (current) setCircle(() => module.UploadCircle);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [sending, Circle]);
  const container = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  /** The last control the guest focused in the cards or the circle, to tell when it is taken away. */
  const lastFocused = useRef<HTMLElement | null>(null);
  const { view, showLinkOffer, notice, timeLeft } = snapshot;
  const minimised = snapshot.minimised && Circle !== null;
  const offer = showLinkOffer && link !== null && offerAllowed;
  const unfinished = useSyncExternalStore(subscribeToUnfinished, returnNoticeSnapshot, () => null);
  // Only while sharing is open (closed, the grace's own button offers to finish), and with no card up.
  const returnNotice = sharingOpen && view.kind === "none" ? unfinished : null;

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (container.current?.contains(target) || target.closest("[data-upload-circle]"))) lastFocused.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  /**
   * Somewhere sensible once what held the focus has gone: a row's ×, the card, the personal-link
   * offer, else the first share button; never inside what is fading away.
   */
  function focusSomewhereSensible(position = 0): void {
    const root = container.current;
    const staying = (selector: string) => [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((element) => !element.closest("[inert]"));
    const actions = staying("[data-item-action]");
    const target = actions[Math.min(position, actions.length - 1)] ?? staying("[data-upload-card]")[0] ?? staying("[data-link-offer]")[0] ?? firstVisiblePicker();
    // Without scrolling: a guest looking through the album stays where they are.
    target?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    const request = focusRequest.current;
    const root = container.current;
    const actionOf = (itemId: string) => root?.querySelector<HTMLElement>(`[data-item-action="${CSS.escape(itemId)}"]`) ?? null;
    if (request?.kind === "circle") {
      document.querySelector<HTMLElement>("[data-upload-circle]")?.focus();
      focusRequest.current = null;
      return;
    }
    if (request?.kind === "retried") {
      const own = actionOf(request.itemId);
      if (own) {
        own.focus();
        focusRequest.current = null;
      }
      return;
    }
    if (request) {
      if (request.kind === "row-left" && actionOf(request.itemId)) return;
      focusRequest.current = null;
      if (request.kind === "card") {
        (root?.querySelector<HTMLElement>("[data-upload-card]") ?? firstVisiblePicker())?.focus();
        return;
      }
      focusSomewhereSensible(request.position);
      return;
    }
    // Focus never stays on something taken away: a row or a card that tidied itself (Ruling BC).
    const focused = lastFocused.current;
    const nowhere = document.activeElement === null || document.activeElement === document.body;
    if (focused && nowhere && (!focused.isConnected || focused.closest("[inert]"))) {
      lastFocused.current = null;
      focusSomewhereSensible();
    }
  });

  const positionOf = (itemId: string) => (view.kind === "batch" ? view.items.findIndex((item) => item.id === itemId) : 0);
  const actions = {
    onRetry(itemId: string) {
      const cancelling = snapshot.items.find((item) => item.id === itemId)?.failure?.cancelFailed;
      focusRequest.current = cancelling ? { kind: "row-left", itemId, position: positionOf(itemId) } : { kind: "retried", itemId };
      retry(itemId);
    },
    onCancel(itemId: string) {
      focusRequest.current = { kind: "row-left", itemId, position: positionOf(itemId) };
      cancel(itemId);
    },
    onDismiss(itemId: string) {
      focusRequest.current = { kind: "row-left", itemId, position: positionOf(itemId) };
      dismiss(itemId);
    },
    onChooseAgain(itemId: string) {
      chooseAgain(itemId);
    },
  };
  const cardExtras = {
    onMinimise: Circle
      ? () => {
          // Asked for inside the change itself, so a progress render before it can't take it.
          morph(
            "minimise",
            () => {
              focusRequest.current = { kind: "circle" };
              setMinimised(true);
            },
            "[data-upload-card]",
            "[data-upload-circle]",
          );
        }
      : null,
    notice,
    timeLeft,
  };

  const card =
    minimised ? null : view.kind === "camera" ? (
      <CameraCard
        key={view.item.id}
        item={view.item}
        {...actions}
        {...cardExtras}
        onTakeAnother={() => reopen(view.item.source === "video" ? "video" : "photo")}
      />
    ) : view.kind === "batch" ? (
      <BatchCard view={view} {...actions} {...cardExtras} />
    ) : null;
  // The circle lives in the dock beside the music, not under the header.
  const floating =
    minimised && Circle ? (
      <DockItem>
        <Circle
          snapshot={snapshot}
          onOpen={() => {
            morph(
              "reopen",
              () => {
                focusRequest.current = { kind: "card" };
                setMinimised(false);
              },
              "[data-upload-circle]",
              "[data-upload-card]",
            );
          }}
          onGone={(hadFocus) => {
            if (hadFocus) focusSomewhereSensible();
          }}
        />
      </DockItem>
    ) : null;

  if (!card && !offer && !returnNotice) return floating;
  return (
    <>
      <div ref={container} className="flex flex-col gap-3">
        {returnNotice ? <ReturnNotice notice={returnNotice} onChoose={chooseFiles} /> : null}
        {card}
        {offer ? (
          <Suspense fallback={null}>
            <PersonalLinkOffer
              link={link}
              onHidden={() => {
                const shownCard = container.current?.querySelector<HTMLElement>("[data-upload-card]");
                (shownCard ?? firstVisiblePicker())?.focus();
              }}
            />
          </Suspense>
        ) : null}
      </div>
      {floating}
    </>
  );
}
