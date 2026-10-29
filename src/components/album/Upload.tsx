"use client";

import { createContext, use, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Halo } from "@/components/ui/Halo";
import { Icon, type IconName } from "@/components/ui/Icon";

/** Where a file comes from: the phone's camera (photo or video) or its gallery. */
type Source = "photo" | "video" | "gallery";
type CameraSource = Exclude<Source, "gallery">;

/** One shot straight from the camera, shown with its thumbnail. */
type Shot = { kind: "shot"; source: CameraSource; url: string; isVideo: boolean; sent: boolean };
/** Several files picked from the gallery. */
type Batch = { kind: "batch"; current: number; total: number; percent: number };

const UploadContext = createContext<{
  state: Shot | Batch | null;
  start: (files: FileList, source: Source) => void;
  /** Remembers a camera input, so "Take another" can reopen the camera. */
  register: (source: CameraSource, el: HTMLInputElement | null) => void;
  reopen: (source: CameraSource) => void;
} | null>(null);

function useUpload() {
  const ctx = use(UploadContext);
  if (!ctx) throw new Error("Album upload controls must sit inside <UploadProvider>.");
  return ctx;
}

/** Shares the upload state between the share buttons and the status card under the header. */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Shot | Batch | null>(null);
  const inputs = useRef<Partial<Record<CameraSource, HTMLInputElement | null>>>({});
  const preview = useRef<string | null>(null);

  // Let go of the last thumbnail's memory when it's replaced or the page closes.
  useEffect(() => () => {
    if (preview.current) URL.revokeObjectURL(preview.current);
  }, []);

  function start(files: FileList, source: Source) {
    const total = files.length;
    if (!total) return;
    // TODO: upload to S3 with presigned multipart URLs (resumable, a few files at a
    // time), then add each finished file to the album and mark it sent.
    // For now this only shows the status card for the picked files.
    if (source !== "gallery" && total === 1) {
      const file = files[0];
      if (preview.current) URL.revokeObjectURL(preview.current);
      preview.current = URL.createObjectURL(file);
      setState({ kind: "shot", source, url: preview.current, isVideo: file.type.startsWith("video/"), sent: false });
      return;
    }
    setState({ kind: "batch", current: 1, total, percent: Math.max(6, Math.round(50 / total)) });
  }

  const register = (source: CameraSource, el: HTMLInputElement | null) => {
    inputs.current[source] = el;
  };
  const reopen = (source: CameraSource) => inputs.current[source]?.click();

  return <UploadContext value={{ state, start, register, reopen }}>{children}</UploadContext>;
}

const choices: Record<Source, { icon: IconName; primary: string; secondary: string; accept: string }> = {
  photo: { icon: "camera", primary: "Take a photo", secondary: "Take a photo", accept: "image/*" },
  video: { icon: "video", primary: "Record a video", secondary: "Record video", accept: "video/*" },
  gallery: { icon: "image", primary: "Choose photos & videos", secondary: "From your phone", accept: "image/*,video/*" },
};

/**
 * One way to share: a label around a hidden file input, so the phone's own camera or
 * gallery opens natively. `capture` hands off to the camera app (full quality, no
 * permission prompt, and it works inside WhatsApp's browser).
 */
function PickButton({ source, primary = false, className = "" }: { source: Source; primary?: boolean; className?: string }) {
  const { start, register } = useUpload();
  const c = choices[source];

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) start(e.target.files, source);
    e.target.value = "";
  }

  const input = (
    <input
      ref={source === "gallery" ? undefined : (el) => register(source, el)}
      type="file"
      accept={c.accept}
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
        <Halo icon={c.icon} tone="glass" size="lg" />
        {c.primary}
        {input}
      </label>
    );
  }
  return (
    <label
      className={`press flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full border border-ember/55 px-3 text-[11px] whitespace-nowrap uppercase tracking-[0.12em] text-white transition-colors hover:bg-white/5 ${focus} ${className}`}
    >
      <Icon name={c.icon} size={15} className="shrink-0 text-ember" />
      {c.secondary}
      {input}
    </label>
  );
}

const touchOnly = "[@media(pointer:fine)]:hidden";
const fineOnly = "hidden [@media(pointer:fine)]:flex";

/**
 * The share buttons. On the wedding weekend the camera comes first; before and after,
 * the gallery does. Laptops have no camera to hand off to, so they get the gallery only.
 */
export function ShareButtons({ cameraFirst }: { cameraFirst: boolean }) {
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

/** Holds the buttons' space while the page works out which comes first. */
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

/** The white card under the header: the last shot with "Take another", or a batch's progress. */
export function UploadProgress() {
  const { state, reopen } = useUpload();
  if (!state) return null;

  if (state.kind === "shot") {
    const { source, url, isVideo, sent } = state;
    return (
      <section
        key={url}
        aria-label={isVideo ? "Your video" : "Your photo"}
        className="relative flex animate-rise items-center gap-3.5 rounded-[var(--radius-paper)] bg-white p-3 shadow-[var(--shadow-paper)]"
      >
        <span className="relative size-14 shrink-0">
          {isVideo ? (
            // #t=0.1 makes iPhones draw the first frame instead of a blank box.
            <video src={`${url}#t=0.1`} muted playsInline preload="metadata" className="size-14 rounded-[3px] bg-tile object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of the guest's own file
            <img src={url} alt="" className="size-14 rounded-[3px] bg-tile object-cover" />
          )}
          <span
            className={`absolute -right-1.5 -bottom-1.5 flex size-5.5 items-center justify-center rounded-full ring-2 ring-white transition-colors duration-300 ${
              sent ? "bg-ember text-white" : "bg-tray text-mocha"
            }`}
          >
            {sent ? (
              <Icon name="check" size={12} strokeWidth={2.4} className="animate-rise" />
            ) : (
              <span className="size-3 animate-spin rounded-full border-2 border-mocha/30 border-t-mocha" />
            )}
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5" aria-live="polite">
          <span className="font-serif text-xl leading-tight italic">{sent ? "Added to the album" : "Sending to the album"}</span>
          <span className="text-xs text-mocha">{sent ? "Everyone can see it now" : "Keep this page open for a moment"}</span>
        </div>
        <button
          type="button"
          onClick={() => reopen(source)}
          className="press flex min-h-11 shrink-0 cursor-pointer items-center rounded-full border-0 bg-ember px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-cocoa"
        >
          {source === "video" ? "Record another" : "Take another"}
        </button>
      </section>
    );
  }

  const { current, total, percent } = state;
  return (
    <section
      aria-label="Upload progress"
      className="relative flex animate-rise items-center gap-3.5 rounded-[var(--radius-paper)] bg-white p-4 shadow-[var(--shadow-paper)]"
    >
      <Halo icon="upload" size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-sm font-medium" aria-live="polite">
          Sending {current} of {total}
        </span>
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Upload progress"
          className="h-1.5 overflow-hidden rounded-[3px] bg-tray"
        >
          {/* Keyed so the fill animation replays for each new batch. */}
          <div
            key={`${total}-${percent}`}
            className="h-full animate-fill rounded-[3px] bg-ember transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs text-mocha">Keep this page open while they send.</span>
      </div>
    </section>
  );
}
