"use client";

import { createContext } from "react";

/*
 * What the album's grid hears from the uploader above it (Task 15), in a module of its own so the
 * grid can listen without carrying the uploader (the home page's album has none):
 * - `sendAgain`: a failed tile's "Send again" (gate A) opens the phone's gallery through the share
 *   buttons; null while sharing is closed, or where there are no share buttons;
 * - `added`: how many files have been added on this page, so the grid looks for new moments soon
 *   after one lands rather than waiting out its 30 s.
 */
export type AlbumUploads = { sendAgain: (() => void) | null; added: number };

export const AlbumUploadsContext = createContext<AlbumUploads>({ sendAgain: null, added: 0 });
