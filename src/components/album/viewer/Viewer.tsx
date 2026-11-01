"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useMusic } from "@/components/music/MusicProvider";
import { Halo } from "@/components/ui/Halo";
import { Icon, PlayGlyph } from "@/components/ui/Icon";
import { detailWords, downloadFilename, sharedByWords, sizeWords, type AlbumItem } from "@/lib/media/album-item";
import { askPlayable, downloadLink, fetchItem, removeMoment } from "../album-client";
import { canShareFiles, copyText, inAppBrowser } from "./device";
import { downloadChoices, savable, type DownloadChoice } from "./downloads";
import { choosePlayback, type PlaybackChoice } from "./playback";
import { downloadFile, fetchWhole, shareFile } from "./save";
import "./viewer.css";

/*
 * The viewer (Task 15, gate B 1a–1e): a moment full screen, grown out of its tile, at #m/<id> so
 * Back closes it and the link opens it for anyone. Swipe (or the arrow keys) to move along; tap the
 * picture to hide the buttons. "Shared by …" and "{Celebration} · {time}", with a counter. Save to
 * Photos (two taps), Download (a menu of what the moment comes as) and, on the guest's own, Remove my
 * upload (with a confirm step). A video plays its phone version (playback.ts), never its original;
 * one this phone can't play yet shows its poster and "Preparing a version for your phone…", asks
 * for it, and plays once it is ready. Inside WhatsApp's browser it says to open the page in the
 * phone's own browser, with Copy link.
 */

export type ViewerProps = {
  /** The moments it moves through, as the grid has them (listed ones only). */
  items: AlbumItem[];
  startId: string;
  /** The tile it grows out of, if it was tapped. */
  tile: HTMLElement | null;
  /** How many moments the album holds for this filter, for the counter. */
  total: number;
  /** Closing (Back, or ×): it flies back to its tile, then says so (onExited). */
  closing: boolean;
  /** The moment on screen changed: the address follows. */
  onMove: (mediaId: string) => void;
  /** Near the end of the moments it has: the grid loads its next page. */
  onNearEnd: () => void;
  onRequestClose: () => void;
  onExited: () => void;
  /** A moment the viewer learned more of (its phone version made). */
  onChanged: (item: AlbumItem) => void;
  /** The guest removed their own moment. */
  onRemoved: (item: AlbumItem) => void;
  tileOf: (mediaId: string) => HTMLElement | null;
};

const SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";
const EXIT = "cubic-bezier(0.4, 0, 1, 1)";
/** How often a video being prepared asks after its phone version. */
const PREPARING_CHECK_MILLISECONDS = 10_000;
/** How long a video waits for a copy on its way before asking for a conversion instead. */
const COPY_WAIT_MILLISECONDS = 60_000;
/** A HEIC's JPEG: asked after every few seconds, for at most two minutes. */
const JPEG_CHECK_MILLISECONDS = 3_000;
const JPEG_CHECKS = 40;
/** A save bigger than this says how much it costs on mobile data. */
const SIZE_WORTH_SAYING = 5 * 1024 * 1024;

function moves(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A rectangle as a clip-path inset of the window, rounded like a tile. */
function insetOf(element: HTMLElement): string {
  const box = element.getBoundingClientRect();
  return `inset(${box.top}px ${window.innerWidth - box.right}px ${window.innerHeight - box.bottom}px ${box.left}px round 3px)`;
}

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });

type SavePhase = { phase: "idle" } | { phase: "preparing"; percent: number | null } | { phase: "ready"; file: File } | { phase: "done" };

export function Viewer(props: ViewerProps) {
  const { items, startId, total, closing, onMove, onNearEnd, onRequestClose, onExited, onChanged, onRemoved, tileOf } = props;
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const slide = useRef<HTMLDivElement>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [currentId, setCurrentId] = useState(startId);
  const [chrome, setChrome] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState("");
  const [save, setSave] = useState<SavePhase>({ phase: "idle" });
  const [makingJpeg, setMakingJpeg] = useState(false);
  const [copied, setCopied] = useState(false);
  const [needsConversion, setNeedsConversion] = useState<ReadonlySet<string>>(() => new Set());
  const [readyChip, setReadyChip] = useState<string | null>(null);
  const statusTimer = useRef<number | null>(null);
  /** The side the next moment comes in from, for its slide-in. */
  const entering = useRef<-1 | 0 | 1>(0);
  /** Where focus goes once the viewer has gone and the page is live again: the tile it closed onto. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const environment = useMemo(() => ({ inApp: inAppBrowser(navigator.userAgent), shareFiles: canShareFiles() }), []);
  const music = useMusic();

  // The moment on screen; should it leave the list some other way, the first.
  const index = Math.max(0, items.findIndex((item) => item.id === currentId));
  const item = items[index] as AlbumItem | undefined;

  const playback: PlaybackChoice | null = useMemo(() => {
    if (!item?.video) return null;
    if (needsConversion.has(item.id)) {
      return item.video.converted ? { kind: "converted", url: item.video.converted } : { kind: "preparing", ask: true };
    }
    return choosePlayback(item.video, (type) => document.createElement("video").canPlayType(type));
  }, [item, needsConversion]);

  const say = useCallback((text: string, lingerMilliseconds = 0) => {
    if (statusTimer.current) window.clearTimeout(statusTimer.current);
    setStatus(text);
    if (lingerMilliseconds) statusTimer.current = window.setTimeout(() => setStatus(""), lingerMilliseconds);
  }, []);

  // ---------- Opening and closing ----------

  // The page beneath goes quiet: no scrolling, nothing focusable, while the viewer is up.
  useLayoutEffect(() => {
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const quieted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children) as HTMLElement[]) {
      if (child.contains(root.current) || child.inert) continue;
      child.inert = true;
      quieted.push(child);
    }
    return () => {
      document.documentElement.style.overflow = overflow;
      for (const child of quieted) child.inert = false;
      returnFocus.current?.focus({ preventScroll: true });
    };
  }, []);

  // It grows out of the tile it was opened from.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (!moves()) return;
    if (props.tile?.isConnected) {
      element.animate([{ clipPath: insetOf(props.tile) }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 460, easing: SETTLE });
    } else {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: SETTLE });
    }
    element.querySelector(".viewer-top")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 220, easing: SETTLE, fill: "backwards" });
    element.querySelector(".viewer-bottom")?.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 200, easing: SETTLE, fill: "backwards" });
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing flies back to the tile of the moment on screen (or fades), then hands focus back to it.
  useEffect(() => {
    if (!closing) return;
    const element = root.current;
    const tile = item ? tileOf(item.id) : null;
    returnFocus.current = tile?.querySelector("button") ?? null;
    const finish = () => onExited();
    if (!element || !moves()) {
      finish();
      return;
    }
    let animation: Animation;
    if (tile) {
      tile.scrollIntoView({ block: "nearest" });
      animation = element.animate(
        [{ clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 }, { clipPath: insetOf(tile), opacity: 0.6 }],
        { duration: 380, easing: SETTLE, fill: "forwards" },
      );
    } else {
      animation = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: EXIT, fill: "forwards" });
    }
    animation.finished.then(finish, finish);
    // Once, as it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  // Nothing left to show (the last one removed): it closes.
  useEffect(() => {
    if (items.length === 0 && !closing) onRequestClose();
  }, [items.length, closing, onRequestClose]);

  // The faded top of the buttons' panel may lie over the picture; the rest may not.
  useLayoutEffect(() => {
    const element = panel.current;
    const viewer = root.current;
    if (!element || !viewer) return;
    const observer = new ResizeObserver(() => {
      const statusLine = element.querySelector<HTMLElement>(".viewer-status");
      const statusSpace = statusLine?.textContent ? statusLine.offsetHeight + 12 : 0;
      viewer.style.setProperty("--viewer-bottom", `${Math.max(96, element.offsetHeight - statusSpace - 40)}px`);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ---------- Moving along ----------

  /** Puts another moment on screen: its menu, tray and save start afresh. */
  function moveTo(mediaId: string, direction: -1 | 0 | 1) {
    entering.current = direction;
    setCurrentId(mediaId);
    setMenuOpen(false);
    setConfirming(false);
    setSave({ phase: "idle" });
    setMakingJpeg(false);
    setReadyChip(null);
    onMove(mediaId);
  }

  function goTo(direction: -1 | 1) {
    const target = items[index + direction];
    if (!target) {
      if (moves()) slide.current?.animate([{ transform: `translateX(${direction * -18}px)` }, { transform: "none" }], { duration: 420, easing: SETTLE });
      return;
    }
    say("");
    moveTo(target.id, direction);
    if (index + direction >= items.length - 3) onNearEnd();
  }

  // The next moment's picture is fetched ahead, so a swipe shows it at once.
  useEffect(() => {
    const next = items[index + 1];
    if (next?.view) new Image().src = next.view;
  }, [items, index]);

  // The incoming moment slides in from the side the guest moved to.
  useLayoutEffect(() => {
    const direction = entering.current;
    entering.current = 0;
    if (!direction || !slide.current || !moves()) return;
    slide.current.animate([{ transform: `translateX(${direction * 35}%)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 480, easing: SETTLE });
  }, [item?.id]);

  /** Swipe to move, tap to hide the buttons. */
  const drag = useRef<{ startX: number; startY: number; startedAt: number; pointerId: number } | null>(null);
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, video, a")) return;
    drag.current = { startX: event.clientX, startY: event.clientY, startedAt: event.timeStamp, pointerId: event.pointerId };
    stage.current?.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId || !slide.current) return;
    const travel = event.clientX - current.startX;
    const atEdge = (travel > 0 && index === 0) || (travel < 0 && index === items.length - 1);
    slide.current.style.transform = `translateX(${atEdge ? travel * 0.3 : travel}px)`;
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    const travel = event.clientX - current.startX;
    const distance = Math.abs(travel) + Math.abs(event.clientY - current.startY);
    const element = slide.current;
    if (element) element.style.transform = "";
    if (distance < 8) {
      setChrome((shown) => !shown);
      return;
    }
    const flick = Math.abs(travel) / Math.max(event.timeStamp - current.startedAt, 1) > 0.5;
    if (Math.abs(travel) > 70 || (flick && Math.abs(travel) > 24)) goTo(travel < 0 ? 1 : -1);
    else if (element && moves()) element.animate([{ transform: `translateX(${travel}px)` }, { transform: "none" }], { duration: 420, easing: SETTLE });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirming) closeConfirm();
      else if (menuOpen) closeMenu(true);
      else onRequestClose();
      return;
    }
    if (confirming || menuOpen) return;
    // In a video's own controls the arrow keys seek.
    if ((event.target as HTMLElement).tagName === "VIDEO" && event.key.startsWith("Arrow")) return;
    if (event.key === "ArrowRight") goTo(1);
    else if (event.key === "ArrowLeft") goTo(-1);
    else if (event.key === "Tab") keepFocusInside(event);
  }

  /** Tab stays inside the viewer (it is modal). */
  function keepFocusInside(event: ReactKeyboardEvent<HTMLDivElement>) {
    const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href], video[controls]") ?? []).filter(
      (element) => element.offsetParent !== null && !element.closest("[inert], [aria-hidden='true']"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------- A video's phone version ----------

  useEffect(() => {
    if (!item?.video || playback?.kind !== "preparing") return;
    const controller = new AbortController();
    const mediaId = item.id;
    const startedAt = Date.now();
    let asked = false;
    /** A newer state of the moment: once it plays here, the chip says so. */
    const learn = (fresh: AlbumItem) => {
      onChanged(fresh);
      const now = fresh.video ? choosePlayback(fresh.video, (type) => document.createElement("video").canPlayType(type)) : null;
      if (now?.kind === "converted" || now?.kind === "copy") {
        setReadyChip(mediaId);
        window.setTimeout(() => setReadyChip((shown) => (shown === mediaId ? null : shown)), 2_600);
      }
    };
    const ask = async () => {
      asked = true;
      const answer = await askPlayable(mediaId, controller.signal);
      if (controller.signal.aborted || !answer || !item.video) return;
      if (answer.status === "ready") learn({ ...item, video: { ...item.video, converted: answer.url, conversion: "done" } });
      else if (answer.status === "failed") onChanged({ ...item, video: { ...item.video, conversion: "failed", conversionFailure: answer.reason } });
    };
    (async () => {
      if (playback.ask) await ask();
      while (!controller.signal.aborted) {
        await wait(PREPARING_CHECK_MILLISECONDS, controller.signal);
        if (controller.signal.aborted) return;
        if (document.visibilityState !== "visible") continue;
        const fresh = await fetchItem(mediaId, controller.signal).catch(() => undefined);
        if (controller.signal.aborted) return;
        if (fresh) learn(fresh);
        // A copy that was on its way and hasn't come: the conversion, on demand, instead.
        if (!asked && Date.now() - startedAt > COPY_WAIT_MILLISECONDS) await ask();
      }
    })();
    return () => controller.abort();
    // While this moment is being prepared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, playback?.kind]);

  /** A version that wouldn't play (a link gone stale, or a copy this phone can't play after all): asked after once, then converted. */
  const failedUrls = useRef(new Set<string>());
  async function onVideoError(url: string) {
    if (!item) return;
    if (!failedUrls.current.has(url)) {
      failedUrls.current.add(url);
      const fresh = await fetchItem(item.id).catch(() => undefined);
      if (fresh === null) {
        say("This moment isn't in the album any more.", 4_000);
        return;
      }
      if (fresh && (fresh.video?.converted !== item.video?.converted || fresh.video?.copy !== item.video?.copy)) {
        onChanged(fresh);
        return;
      }
    }
    setNeedsConversion((current) => new Set(current).add(item.id));
  }

  // ---------- Download ----------

  const choices = item ? downloadChoices(item) : [];

  function openMenu() {
    setMenuOpen(true);
    window.setTimeout(() => root.current?.querySelector<HTMLElement>(".viewer-choice:not(:disabled)")?.focus({ preventScroll: true }), 80);
  }
  function closeMenu(focus: boolean) {
    setMenuOpen(false);
    if (focus) downloadButton.current?.focus({ preventScroll: true });
  }

  /** A download through the route, which redirects to its link: the page stays where it is. */
  function startDownload(variant: string) {
    if (!item) return;
    const link = document.createElement("a");
    link.href = `/api/media/${item.id}/download?variant=${variant}`;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function choose(choice: DownloadChoice) {
    if (!item || choice.disabled) return;
    if (choice.variant !== "jpeg") {
      closeMenu(true);
      startDownload(choice.variant);
      say(
        choice.variant === "original"
          ? `Downloading the original (${sizeWords(item.original.bytes)}). It'll be in your downloads.`
          : "Downloading the phone version. It'll be in your downloads.",
        5_000,
      );
      return;
    }
    // The first request for a JPEG makes it: the row says so, and the menu waits.
    setMakingJpeg(true);
    const controller = new AbortController();
    const mediaId = item.id;
    for (let check = 0; check < JPEG_CHECKS; check += 1) {
      const answer = await downloadLink(mediaId, "jpeg", controller.signal);
      if (mediaId !== currentIdRef.current) return;
      if (answer.status === "ready") {
        setMakingJpeg(false);
        closeMenu(true);
        startDownload("jpeg");
        say("Downloading the JPEG. It'll be in your downloads.", 5_000);
        return;
      }
      if (answer.status !== "preparing") break;
      await wait(JPEG_CHECK_MILLISECONDS, controller.signal);
    }
    setMakingJpeg(false);
    say("We couldn't make the JPEG just now. Download the original instead.", 6_000);
  }
  const currentIdRef = useRef<string | null>(currentId);
  useEffect(() => {
    currentIdRef.current = item?.id ?? null;
  });

  // ---------- Save to Photos ----------

  const saving = item ? savable(item, playback) : null;
  const saveAbort = useRef<AbortController | null>(null);
  useEffect(() => () => saveAbort.current?.abort(), [item?.id]);

  async function onSave() {
    if (!item || !saving) return;
    if (save.phase === "ready") {
      const outcome = await shareFile(save.file);
      if (outcome === "shared") {
        setSave({ phase: "done" });
        say("");
        window.setTimeout(() => setSave((current) => (current.phase === "done" ? { phase: "idle" } : current)), 2_400);
      } else if (outcome === "dismissed") {
        say("Still ready. Tap Save now to try again.");
      } else {
        downloadFile(save.file);
        setSave({ phase: "idle" });
        say("It's in your downloads.", 5_000);
      }
      return;
    }
    if (save.phase === "preparing") return;
    const controller = new AbortController();
    saveAbort.current = controller;
    const mediaId = item.id;
    const filename = downloadFilename(item.celebration, item.id, saving.extension);
    setSave({ phase: "preparing", percent: null });
    say("");
    try {
      let url: string;
      if ("url" in saving) url = saving.url;
      else {
        let answer = await downloadLink(mediaId, saving.variant, controller.signal);
        for (let check = 0; answer.status === "preparing" && check < JPEG_CHECKS; check += 1) {
          await wait(JPEG_CHECK_MILLISECONDS, controller.signal);
          answer = await downloadLink(mediaId, saving.variant, controller.signal);
        }
        if (answer.status !== "ready") throw new Error("No link");
        url = answer.url;
      }
      const blob = await fetchWhole(url, {
        signal: controller.signal,
        onProgress: (fraction, totalBytes) => {
          setSave({ phase: "preparing", percent: fraction === null ? null : Math.round(fraction * 100) });
          if (totalBytes && totalBytes > SIZE_WORTH_SAYING) say(`${sizeWords(totalBytes)} on mobile data. Keep this open.`);
        },
      });
      if (controller.signal.aborted) return;
      setSave({ phase: "ready", file: new File([blob], filename, { type: saving.type }) });
      say("Ready. Tap Save now, then choose where to keep it.");
      saveButton.current?.focus({ preventScroll: true });
    } catch {
      if (controller.signal.aborted) return;
      // The file couldn't be fetched into the page: it downloads instead.
      setSave({ phase: "idle" });
      if ("variant" in saving) {
        startDownload(saving.variant);
        say("Downloading it instead. It'll be in your downloads.", 5_000);
      } else say("We couldn't get it ready. Try again in a moment.", 5_000);
    }
  }

  // ---------- Remove my upload ----------

  function openConfirm() {
    setConfirming(true);
    window.setTimeout(() => keepButton.current?.focus({ preventScroll: true }), 60);
  }
  function closeConfirm() {
    setConfirming(false);
    removeButton.current?.focus({ preventScroll: true });
  }
  async function removeCurrent() {
    if (!item || removing) return;
    setRemoving(true);
    const outcome = await removeMoment(item.id);
    if (outcome !== "removed") {
      setRemoving(false);
      setConfirming(false);
      say(outcome === "refused" ? "This one can't be removed from here." : "We couldn't remove it just now. Try again in a moment.", 6_000);
      return;
    }
    setConfirming(false);
    if (slide.current && moves()) {
      await slide.current
        .animate([{ transform: "none", opacity: 1 }, { transform: "translateY(28%) rotate(7deg) scale(0.55)", opacity: 0 }], {
          duration: 560,
          easing: "cubic-bezier(0.5, 0, 0.75, 0)",
          fill: "forwards",
        })
        .finished.catch(() => {});
    }
    const neighbour = items[index + 1] ?? items[index - 1];
    if (neighbour) moveTo(neighbour.id, 0);
    onRemoved(item);
    setRemoving(false);
    say("Removed from the album.", 4_000);
  }

  // ---------- Copy link (inside an app's browser) ----------

  async function onCopy() {
    if (!item) return;
    await copyText(`${window.location.origin}/album#m/${item.id}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_400);
  }

  if (!item) return null;

  // The status line: what just happened, else what the moment is waiting for.
  const waitingWords =
    playback?.kind === "failed" ? playback.words : item.kind === "video" && playback?.kind === "preparing" && environment.shareFiles && !environment.inApp
      ? "You can save it once your phone's version is ready."
      : "";
  const statusLine = status || waitingWords;
  const ratio = item.width && item.height ? item.width / item.height : 3 / 4;
  const waiting = item.kind === "video" && !saving;
  const showSave = environment.shareFiles && !environment.inApp;
  const downloadLeads = !showSave && !environment.inApp;
  const saveLabel = save.phase === "preparing" ? "Getting it ready" : save.phase === "ready" ? "Save now" : save.phase === "done" ? "Done" : "Save to Photos";

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Moment"
      tabIndex={-1}
      data-chrome={chrome ? "on" : "off"}
      data-layer={confirming ? "confirm" : undefined}
      className="viewer"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (menuOpen && !(event.target as HTMLElement).closest(".viewer-dl")) closeMenu(false);
      }}
    >
      <div aria-hidden className="viewer-backdrop" style={{ backgroundColor: item.color ?? undefined, backgroundImage: item.thumb ? `url(${item.thumb})` : undefined }} />
      <div ref={stage} className="viewer-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <div
          ref={slide}
          key={item.id}
          className="viewer-slide"
          style={{
            aspectRatio: String(ratio),
            width: `min(100cqw, calc(100cqh * ${ratio}))`,
            backgroundColor: item.color ?? undefined,
            backgroundImage: item.thumb ? `url(${item.thumb})` : undefined,
          }}
        >
          {item.kind === "video" ? (
            <VideoSlide item={item} playback={playback} readyChip={readyChip === item.id} onPlay={() => music.playing && music.pause()} onError={onVideoError} />
          ) : item.view ? (
            // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
            <img src={item.view} alt={`Photo ${sharedByWords(item).toLowerCase()}`} className="absolute inset-0 size-full object-cover" draggable={false} />
          ) : null}
        </div>
      </div>

      <div className="viewer-top">
        <p className="viewer-count" aria-live="polite">
          <span className="sr-only">Moment </span>
          {index + 1}
          <span aria-hidden> / </span>
          <span className="sr-only"> of </span>
          {Math.max(total, items.length)}
        </p>
        <p className="viewer-keys">Arrow keys to move, Esc to close</p>
        <button type="button" className="viewer-icon-button press" aria-label="Close" onClick={onRequestClose}>
          <Icon name="close" size={22} />
        </button>
      </div>
      <button type="button" className="viewer-arrow viewer-prev press" aria-label="Previous moment" disabled={index === 0} onClick={() => goTo(-1)}>
        <Icon name="back" size={22} />
      </button>
      <button type="button" className="viewer-arrow viewer-next press" aria-label="Next moment" disabled={index === items.length - 1} onClick={() => goTo(1)}>
        <Icon name="forward" size={22} />
      </button>

      <div ref={panel} className="viewer-bottom">
        <div className="viewer-caption">
          <p className="viewer-by">
            <span className="viewer-by-text">{sharedByWords(item)}</span>
            {item.mine ? <span role="img" aria-label="Your upload" className="viewer-mine" /> : null}
          </p>
          <p className="viewer-detail">{detailWords(item)}</p>
        </div>
        {environment.inApp ? (
          <div className="viewer-hint">
            <Halo icon="external" tone="dark" />
            <div>
              <p className="viewer-hint-title">To save, open this page in your browser</p>
              <p className="viewer-hint-sub">Downloads often stop inside WhatsApp. Copy the link, then paste it into Chrome or Safari.</p>
            </div>
          </div>
        ) : null}
        <p className="viewer-status" aria-live="polite">
          {statusLine}
        </p>
        <div className="viewer-actions">
          {environment.inApp ? (
            <button type="button" className="viewer-wide press" onClick={onCopy}>
              <Icon name={copied ? "check" : "copy"} size={16} />
              {copied ? "Copied" : "Copy link"}
            </button>
          ) : showSave ? (
            <button
              ref={saveButton}
              type="button"
              className="viewer-save"
              data-save={save.phase}
              aria-disabled={waiting}
              onClick={waiting ? undefined : onSave}
              style={{ ["--save-percent" as string]: `${save.phase === "preparing" ? (save.percent ?? 0) : 0}%` }}
            >
              <span className="viewer-save-fill" aria-hidden />
              <span className="viewer-save-halo" aria-hidden>
                {save.phase === "preparing" ? <span className="viewer-spinner" /> : <Icon name={save.phase === "idle" ? "save" : "check"} size={18} />}
              </span>
              <span className="viewer-save-text">
                <span>{saveLabel}</span>
                {save.phase === "preparing" && save.percent !== null ? <span className="viewer-save-percent">{save.percent}%</span> : null}
              </span>
            </button>
          ) : null}
          <div className="viewer-secondary">
            <div className="viewer-dl">
              <button
                ref={downloadButton}
                type="button"
                className={`viewer-download press${downloadLeads ? " is-primary" : ""}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
              >
                <Icon name="download" size={16} />
                <span>Download</span>
                <Icon name="chevron" size={14} className="viewer-chevron" />
              </button>
              <div
                role="menu"
                aria-label="Download"
                className={`viewer-menu${menuOpen ? " is-open" : ""}`}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".viewer-choice:not(:disabled)"));
                  const at = entries.indexOf(document.activeElement as HTMLElement);
                  entries[(at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length]?.focus();
                }}
              >
                <div className="viewer-menu-head">
                  <p>Download</p>
                  <button type="button" className="viewer-icon-button" aria-label="Close the menu" onClick={() => closeMenu(true)} tabIndex={menuOpen ? 0 : -1}>
                    <Icon name="close" size={18} />
                  </button>
                </div>
                {choices.map((choice) => {
                  const busy = choice.prepare && makingJpeg;
                  return (
                    <button
                      key={choice.variant}
                      type="button"
                      role="menuitem"
                      className="viewer-choice"
                      disabled={choice.disabled || busy}
                      tabIndex={menuOpen ? 0 : -1}
                      onClick={() => choose(choice)}
                    >
                      <span>
                        <span className="viewer-choice-label">{choice.label}</span>
                        <span className="viewer-choice-sub">{busy ? "Making the JPEG…" : choice.sub}</span>
                      </span>
                      {choice.disabled || busy ? <span className="viewer-spinner is-light" aria-hidden /> : <Icon name="download" size={18} />}
                    </button>
                  );
                })}
              </div>
            </div>
            {item.mine ? (
              <button ref={removeButton} type="button" className="viewer-remove" onClick={openConfirm}>
                <span>Remove my upload</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className={`viewer-scrim${confirming ? " is-on" : ""}`} onClick={() => !removing && closeConfirm()} aria-hidden />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="viewer-confirm-title"
        aria-describedby="viewer-confirm-body"
        className={`viewer-tray${confirming ? " is-open" : ""}`}
      >
        <p className="viewer-tray-title" id="viewer-confirm-title">
          Remove this from the album?
        </p>
        <p className="viewer-tray-body" id="viewer-confirm-body">
          Everyone will stop seeing it.
        </p>
        <div className="viewer-tray-actions">
          <button ref={keepButton} type="button" className="viewer-ghost press" onClick={closeConfirm} tabIndex={confirming ? 0 : -1}>
            Keep it
          </button>
          <button type="button" className="viewer-ember press" onClick={removeCurrent} tabIndex={confirming ? 0 : -1}>
            {removing ? "Removing…" : "Remove it"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A video on the stage: its poster, with a play button once a version this phone plays is there
 * (then the phone's own controls); while one is prepared, a slow ember sweep and the words; then
 * the chip "Ready to play".
 */
function VideoSlide({
  item,
  playback,
  readyChip,
  onPlay,
  onError,
}: {
  item: AlbumItem;
  playback: PlaybackChoice | null;
  readyChip: boolean;
  onPlay: () => void;
  onError: (url: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const url = playback?.kind === "converted" || playback?.kind === "copy" ? playback.url : null;
  return (
    <>
      {item.view ? (
        // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
        <img src={item.view} alt={`Video ${sharedByWords(item).toLowerCase()}`} className="absolute inset-0 size-full object-cover" draggable={false} />
      ) : null}
      {url && playing ? (
        <video
          key={url}
          src={url}
          poster={item.view ?? undefined}
          controls
          autoPlay
          playsInline
          className="absolute inset-0 size-full bg-black object-contain"
          onPlay={onPlay}
          onError={() => {
            setPlaying(false);
            onError(url);
          }}
        />
      ) : null}
      {url && !playing ? (
        <button type="button" className="viewer-play press" aria-label="Play the video" onClick={() => setPlaying(true)}>
          <PlayGlyph size={24} className="ml-0.5" />
        </button>
      ) : null}
      {playback?.kind === "preparing" ? (
        <div className="viewer-preparing" role="status">
          <span className="viewer-ring">
            <PlayGlyph size={18} className="ml-0.5 opacity-85" />
          </span>
          <p className="viewer-preparing-title">Preparing a version for your phone…</p>
          <p className="viewer-preparing-sub">It takes a minute or two, and plays here when it&apos;s ready.</p>
        </div>
      ) : playback?.kind === "failed" ? (
        <div className="viewer-preparing" role="status">
          <p className="viewer-preparing-title">{playback.words}</p>
        </div>
      ) : null}
      {readyChip && !playing ? <span className="viewer-ready-chip">Ready to play</span> : null}
    </>
  );
}
