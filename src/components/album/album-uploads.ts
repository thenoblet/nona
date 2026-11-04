"use client";

import { createContext } from "react";

/*
 * What the album's grid hears from the uploader above it (Task 15), in a module of its own so the
 * grid can listen without carrying the uploader (the home page's album has none):
 * - `sendAgain`: a failed tile's "Send again" (gate A) opens the phone's gallery through the share
 *   buttons; null while sharing is closed, or where there are no share buttons;
 * - `added`: how many files have been added on this page, so the grid looks for new moments soon
 *   after one lands rather than waiting out its 30 s;
 * - `busy`: whether a file is on its way from this page, so a viewer that can't load never reloads
 *   the page under it.
 */
export type AlbumUploads = { sendAgain: (() => void) | null; added: number; busy: boolean };

export const AlbumUploadsContext = createContext<AlbumUploads>({ sendAgain: null, added: 0, busy: false });
