"use client";

import { useEffect, useRef, useState } from "react";
import { downloadFilename, sizeWords, type AlbumItem } from "@/lib/media/album-item";
import { downloadLink } from "../album-client";
import { startDownload, type Savable } from "./downloads";
import { abortableWait, downloadFile, fetchWhole, prepareSave, shareFile } from "./save";

/*
 * Save to Photos' two taps (gate B 1c), for the viewer: the first fetches the file with its progress,
 * the second hands it to the share menu. A file that won't fetch downloads instead, photo or video
 * (Ruling BO). Moving on, or closing the viewer, stops what the first tap started.
 */

export type SavePhase =
  | { phase: "idle" }
  | { phase: "preparing"; percent: number | null }
  | { phase: "ready"; file: File }
  | { phase: "done" };

/** A save bigger than this says how much it costs on mobile data. */
const SIZE_WORTH_SAYING = 5 * 1024 * 1024;

export function useSaveToPhotos(options: {
  item: AlbumItem | undefined;
  saving: Savable | null;
  say: (text: string, lingerMilliseconds?: number) => void;
  /** Where focus goes once the file is ready: the button, now "Save now". */
  focusSave: () => void;
}) {
  const { item, saving, say, focusSave } = options;
  const [save, setSave] = useState<SavePhase>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);
  // Moving on, or closing the viewer, stops the fetch.
  useEffect(() => () => controller.current?.abort(), [item?.id]);

  /** Back to the start, for another moment. */
  function reset(): void {
    controller.current?.abort();
    controller.current = null;
    setSave({ phase: "idle" });
  }

  async function onSave(): Promise<void> {
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
    const own = new AbortController();
    controller.current?.abort();
    controller.current = own;
    setSave({ phase: "preparing", percent: null });
    say("");
    let sizeSaid = false;
    const prepared = await prepareSave({
      mediaId: item.id,
      source: saving,
      filename: downloadFilename(item.celebration, item.id, saving.extension),
      signal: own.signal,
      onProgress: (fraction, totalBytes) => {
        if (own.signal.aborted) return;
        setSave({ phase: "preparing", percent: fraction === null ? null : Math.round(fraction * 100) });
        if (!sizeSaid && totalBytes && totalBytes > SIZE_WORTH_SAYING) {
          sizeSaid = true;
          say(`${sizeWords(totalBytes)} on mobile data. Keep this open.`);
        }
      },
      dependencies: { downloadLink, fetchWhole, wait: abortableWait },
    });
    if (prepared.kind === "stopped" || own.signal.aborted) return;
    controller.current = null;
    if (prepared.kind === "ready") {
      setSave({ phase: "ready", file: prepared.file });
      say("Ready. Tap Save now, then choose where to keep it.");
      focusSave();
      return;
    }
    // It won't fetch into the page: it downloads the plain way instead.
    setSave({ phase: "idle" });
    startDownload(item.id, prepared.variant);
    say("Downloading it instead. It'll be in your downloads.", 5_000);
  }

  return { save, onSave, reset };
}
