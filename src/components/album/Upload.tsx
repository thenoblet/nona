"use client";

import { createContext, use, useState, type ChangeEvent, type ReactNode } from "react";
import { Halo } from "@/components/ui/Halo";

type UploadState = {
  /** The file being sent, counting from 1. */
  current: number;
  total: number;
  percent: number;
  /** True for the design sample shown before anything is picked. */
  sample: boolean;
};

const SAMPLE: UploadState = { current: 3, total: 5, percent: 60, sample: true };

const UploadContext = createContext<{
  state: UploadState;
  start: (files: FileList) => void;
} | null>(null);

function useUpload() {
  const ctx = use(UploadContext);
  if (!ctx) throw new Error("Album upload controls must sit inside <UploadProvider>.");
  return ctx;
}

/** Shares the upload state between the "Share a moment" button and the progress card. */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UploadState>(SAMPLE);

  function start(files: FileList) {
    const total = files.length;
    if (!total) return;
    // TODO: upload to S3 with presigned multipart URLs (resumable, a few files at a
    // time, data saver on mobile), then add each finished file to the album.
    // For now this only shows the progress card for the picked files.
    setState({ current: 1, total, percent: Math.max(6, Math.round(50 / total)), sample: false });
  }

  return <UploadContext value={{ state, start }}>{children}</UploadContext>;
}

/** The big ember pill. A label around a hidden file input, so the picker opens natively. */
export function ShareMomentButton() {
  const { start } = useUpload();

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) start(e.target.files);
    e.target.value = "";
  }

  return (
    <label className="press flex min-h-16 w-full cursor-pointer items-center gap-3.5 rounded-full bg-ember py-2 pr-6 pl-2 text-[13px] font-medium uppercase tracking-[0.2em] text-cocoa shadow-[var(--shadow-pill-dark)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-ember">
      <Halo icon="camera" tone="glass" size="lg" />
      Share a moment
      <input type="file" accept="image/*,video/*" multiple onChange={onChange} className="sr-only" />
    </label>
  );
}

/** The white card that overlaps the bottom of the header while files upload. */
export function UploadProgress() {
  const { state } = useUpload();
  const { current, total, percent, sample } = state;

  return (
    <section
      aria-label="Upload progress"
      className="relative flex items-center gap-3.5 rounded-[var(--radius-paper)] bg-white p-4 shadow-[var(--shadow-paper)]"
    >
      <Halo icon="upload" size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium" aria-live="polite">
            Uploading {current} of {total}
            {sample ? <span className="sr-only"> (sample)</span> : null}
          </span>
          <span className="text-xs text-mocha">Data saver on</span>
        </div>
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
            key={`${total}-${percent}-${sample}`}
            className="h-full animate-fill rounded-[3px] bg-ember transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs text-mocha">Weak signal? We&apos;ll keep trying in the background.</span>
      </div>
    </section>
  );
}
