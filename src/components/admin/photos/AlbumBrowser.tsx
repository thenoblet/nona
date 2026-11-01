"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  ADMIN_CHIPS,
  ATTENTION_CHIPS,
  CHIP_LABELS,
  adminFilterQuery,
  countsFor,
  type AdminChip,
  type AdminCountRow,
  type AdminFilter,
  type AdminItem,
  type AdminPage,
} from "@/lib/media/admin-item";
import type { AlbumCelebration, AlbumKind } from "@/lib/media/album-item";
import { AdminIcon } from "./AdminIcon";
import { AdminTile } from "./AdminTile";
import { DeletedPanel, EmptyPanel, ItemPanel, type CelebrationOption } from "./ItemPanel";

/** How long the search waits after the last key before it asks. */
const SEARCH_PAUSE_MILLISECONDS = 300;
/** Tiles at the top load at once; the rest as they scroll near. */
const EAGER_TILES = 12;
/** Under this width the panel is a sheet from the bottom of the screen (admin.css). */
const SHEET_QUERY = "(max-width: 899px)";
const LOAD_FAILED = "That didn't load. Check the connection and try again.";
/** A page that hasn't come in this long is given up on. */
const LOAD_TIMEOUT_MILLISECONDS = 15_000;

function subscribeToSheet(onChange: () => void): () => void {
  const query = window.matchMedia(SHEET_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the panel is a sheet (a phone) rather than a column beside the grid. */
function useSheet(): boolean {
  return useSyncExternalStore(subscribeToSheet, () => window.matchMedia(SHEET_QUERY).matches, () => false);
}

/** The panel shows an item, the word that it was deleted, or nothing yet. */
type Selection = { kind: "item"; item: AdminItem } | { kind: "deleted"; mediaId: string } | null;

function filterKey(filter: AdminFilter): string {
  return adminFilterQuery(filter).toString();
}

/** Adds a page's items after those shown, leaving out any already there. */
function appendPage(shown: AdminItem[], page: AdminItem[]): AdminItem[] {
  const known = new Set(shown.map((item) => item.id));
  return [...shown, ...page.filter((item) => !known.has(item.id))];
}

/**
 * The admin's album (gate B, Ruling BW): who shared it, the celebration and kind, the state chips
 * with their counts, then the tiles, newest upload first, and the selected item's panel. The first
 * page comes with the page from the server; a change of filter or "Show more" asks the admin's own
 * route for a page, and the address keeps the filter, so a reload shows the same. An action's
 * result updates its tile at once; the counts and switches come with the page's refresh.
 */
export function AlbumBrowser({
  initialFilter,
  initialPage,
  countRows,
  celebrations,
}: {
  initialFilter: AdminFilter;
  initialPage: AdminPage;
  countRows: AdminCountRow[];
  celebrations: CelebrationOption[];
}) {
  const statusId = useId();
  const [filter, setFilter] = useState<AdminFilter>(initialFilter);
  const [searchText, setSearchText] = useState(initialFilter.search ?? "");
  const [items, setItems] = useState<AdminItem[]>(initialPage.items);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState<"filter" | "more" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheet = useSheet();
  const pending = useRef<AbortController | null>(null);
  // The filter as last chosen, for a search that fires after its pause: never an older one.
  const latestFilter = useRef<AdminFilter>(initialFilter);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const lastTile = useRef<HTMLButtonElement | null>(null);

  const counts = countsFor(countRows, filter);
  const celebrationName = useCallback(
    (id: AlbumCelebration) => celebrations.find((celebration) => celebration.id === id)?.name ?? id,
    [celebrations],
  );

  /** Asks the admin's route for a page of the filter, after the cursor if given. A newer ask cancels an older one. */
  const load = useCallback(async (wanted: AdminFilter, cursor: string | null): Promise<AdminPage | null> => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LOAD_TIMEOUT_MILLISECONDS);
    const query = adminFilterQuery(wanted);
    if (cursor) query.set("cursor", cursor);
    try {
      const response = await fetch(`/admin/photos/items?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`The album answered ${response.status}`);
      return (await response.json()) as AdminPage;
    } catch (error) {
      // Replaced by a newer ask: that one shows its page.
      if (controller.signal.aborted && !timedOut) return null;
      throw error;
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) pending.current = null;
    }
  }, []);

  /** Shows the filter: its first page, and the address that keeps it. */
  const applyFilter = useCallback(
    async (wanted: AdminFilter) => {
      latestFilter.current = wanted;
      setFilter(wanted);
      const query = adminFilterQuery(wanted).toString();
      window.history.replaceState(window.history.state, "", query ? `?${query}` : window.location.pathname);
      setLoading("filter");
      setLoadError(null);
      try {
        const page = await load(wanted, null);
        if (!page) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoading(null);
      } catch {
        setLoadError(LOAD_FAILED);
        setLoading(null);
      }
    },
    [load],
  );

  async function showMore() {
    if (!nextCursor || loading) return;
    setLoading("more");
    setLoadError(null);
    try {
      const page = await load(filter, nextCursor);
      if (!page) return;
      setItems((shown) => appendPage(shown, page.items));
      setNextCursor(page.nextCursor);
      setLoading(null);
    } catch {
      setLoadError(LOAD_FAILED);
      setLoading(null);
    }
  }

  function changeFilter(change: Partial<AdminFilter>) {
    const current = latestFilter.current;
    const wanted: AdminFilter = { ...current, ...change };
    for (const key of Object.keys(wanted) as (keyof AdminFilter)[]) {
      if (wanted[key] === undefined || wanted[key] === "") delete wanted[key];
    }
    if (filterKey(wanted) === filterKey(current)) return;
    void applyFilter(wanted);
  }

  function typeSearch(text: string) {
    setSearchText(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => changeFilter({ search: text.trim() || undefined }), SEARCH_PAUSE_MILLISECONDS);
  }

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      pending.current?.abort();
    },
    [],
  );

  function select(item: AdminItem, tile: HTMLButtonElement) {
    lastTile.current = tile;
    setSelection({ kind: "item", item });
    if (sheet) {
      setSheetOpen(true);
      setTimeout(() => closeButton.current?.focus({ preventScroll: true }), 50);
    }
  }

  function closePanel() {
    if (sheet) {
      setSheetOpen(false);
      lastTile.current?.focus({ preventScroll: true });
    } else {
      setSelection(null);
      lastTile.current?.focus({ preventScroll: true });
    }
  }

  // Escape closes the sheet, as × and a tap outside do.
  useEffect(() => {
    if (!sheet || !sheetOpen) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setSheetOpen(false);
      lastTile.current?.focus({ preventScroll: true });
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [sheet, sheetOpen]);

  /** An action's result: the tile shows the item as it now is, or goes once deleted. */
  function changed(mediaId: string, item: AdminItem | null) {
    if (item) {
      setItems((shown) => shown.map((candidate) => (candidate.id === mediaId ? item : candidate)));
      setSelection({ kind: "item", item });
    } else {
      setItems((shown) => shown.filter((candidate) => candidate.id !== mediaId));
      setSelection({ kind: "deleted", mediaId });
    }
  }

  const selectedId = selection?.kind === "item" ? selection.item.id : null;
  const sheetShowing = sheet && sheetOpen && selection !== null;
  const shownWords =
    loading === "filter"
      ? "Loading…"
      : items.length === 0
        ? "Nothing matches."
        : `Showing ${items.length}${nextCursor ? ", more below" : filter.search ? "" : ` of ${filter.chip ? counts.chips[filter.chip] : counts.total}`}.`;

  return (
    <div>
      <div className="admin-toolbar" inert={sheetShowing}>
        <label className="admin-search">
          <AdminIcon name="search" />
          <input
            type="search"
            placeholder="Who shared it"
            aria-label="Search by the guest who shared it"
            aria-describedby={statusId}
            value={searchText}
            maxLength={80}
            onChange={(event) => typeSearch(event.target.value)}
          />
        </label>
        <div className="admin-celebration">
          <select
            aria-label="Celebration"
            value={filter.celebration ?? ""}
            onChange={(event) => changeFilter({ celebration: (event.target.value || undefined) as AlbumCelebration | undefined })}
          >
            <option value="">All celebrations</option>
            {celebrations.map((celebration) => (
              <option key={celebration.id} value={celebration.id}>
                {celebration.name}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-kind">
          <select
            aria-label="Photos or videos"
            value={filter.kind ?? ""}
            onChange={(event) => changeFilter({ kind: (event.target.value || undefined) as AlbumKind | undefined })}
          >
            <option value="">Photos and videos</option>
            <option value="photo">Photos</option>
            <option value="video">Videos</option>
          </select>
        </div>
        <div className="admin-filters" role="group" aria-label="Show">
          <button type="button" className="admin-filter" aria-pressed={!filter.chip} onClick={() => changeFilter({ chip: undefined })}>
            All <b className="admin-num">{counts.total}</b>
          </button>
          {ADMIN_CHIPS.map((chip: AdminChip) => (
            <button
              key={chip}
              type="button"
              className={`admin-filter${ATTENTION_CHIPS.has(chip) && counts.chips[chip] > 0 ? " admin-filter-attention" : ""}`}
              aria-pressed={filter.chip === chip}
              onClick={() => changeFilter({ chip })}
            >
              {CHIP_LABELS[chip]} <b className="admin-num">{counts.chips[chip]}</b>
            </button>
          ))}
        </div>
      </div>
      <p className="admin-sr-only" role="status" id={statusId}>
        {shownWords}
      </p>
      <div className="admin-mod" data-busy={loading === "filter" ? "" : undefined}>
        <div inert={sheetShowing}>
          {items.length > 0 ? (
            <ul className="admin-mod-grid" aria-label="Album items">
              {items.map((item, index) => (
                <AdminTile
                  key={item.id}
                  item={item}
                  celebrationName={celebrationName(item.celebration)}
                  selected={item.id === selectedId}
                  eager={index < EAGER_TILES}
                  onSelect={select}
                />
              ))}
            </ul>
          ) : (
            <p className="admin-empty">
              {loading === "filter" ? "Loading…" : "Nothing matches. Try All, or clear the search."}
            </p>
          )}
          {loadError ? (
            <p className="admin-notice admin-notice-bad" role="alert" style={{ marginTop: 12 }}>
              {loadError}
            </p>
          ) : null}
          {nextCursor ? (
            <div className="admin-more">
              <button type="button" className="admin-btn" aria-disabled={loading !== null} onClick={showMore}>
                {loading === "more" ? "Loading…" : "Show more"}
              </button>
            </div>
          ) : null}
        </div>
        <aside className={`admin-panel${sheet && sheetOpen ? " is-open" : ""}`} aria-label="Selected item">
          {selection?.kind === "item" ? (
            <ItemPanel
              key={selection.item.id}
              item={selection.item}
              celebrations={celebrations}
              closeButton={closeButton}
              onClose={closePanel}
              onChanged={changed}
            />
          ) : selection?.kind === "deleted" ? (
            <DeletedPanel key={selection.mediaId} closeButton={closeButton} onClose={closePanel} />
          ) : (
            <EmptyPanel />
          )}
        </aside>
      </div>
      <div
        className={`admin-scrim${sheetShowing ? " is-on" : ""}`}
        aria-hidden="true"
        onClick={() => {
          setSheetOpen(false);
          lastTile.current?.focus({ preventScroll: true });
        }}
      />
    </div>
  );
}
