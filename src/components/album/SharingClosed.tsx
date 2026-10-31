"use client";

import { useSyncExternalStore } from "react";
import { FinishSendingButton } from "./Upload";
import { UploadsClosed } from "./UploadsClosed";
import { browserStorage, createStartedFiles } from "./uploader/local-records";

const noSubscription = () => () => {};

/**
 * Once the couple close sharing (gate A's "Sharing has closed"), with one exception: for the 24
 * hours after the close in which an upload started before it may still finish (`graceUntil`), a
 * phone that has unfinished uploads of its own gets the gallery to finish them instead. The API
 * takes only those. Other phones, and every phone once the grace has passed, see the closed card.
 */
export function SharingClosed({ graceUntil }: { graceUntil: string | null }) {
  const canFinish = useSyncExternalStore(
    noSubscription,
    () => graceUntil !== null && Date.now() < Date.parse(graceUntil) && createStartedFiles(browserStorage()).hasUnfinished(),
    () => false,
  );
  return canFinish ? <FinishSendingButton /> : <UploadsClosed phase="after" />;
}
