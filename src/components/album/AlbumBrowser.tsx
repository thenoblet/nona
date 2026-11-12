"use client";

import { lazy, Suspense, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Icon, PlayGlyph } from "@/components/ui/Icon";
import { Segmented } from "@/components/ui/Segmented";
import {
  adjustStats,
  CELEBRATION_LABELS,
  celebrationsWithItems,
  countFor,
  countWords,
  newMomentsWords,
  type AlbumCelebration,
  type AlbumFilter,
  type AlbumItem,
  type AlbumKind,
  type AlbumPage,
  type AlbumStats,
} from "@/lib/media/album-item";
import { fetchFirstPageWithStats, fetchItem, fetchNewCount, fetchNewer, fetchPage, type NewCountAnswer } from "./album-client";
import { AlbumUploadsContext } from "./album-uploads";
import { MediaTile } from "./MediaTile";
import { useWaitingTiles } from "./use-waiting-tiles";
import { useFreshGuestOnReturn } from "./use-fresh-guest";
import { reloadOnceForMissingChunk } from "./uploader/load";
import { setPersonalLink, usePersonalLink } from "./uploader/personal-link";
import { loadViewer, prefetchViewerWhenIdle } from "./viewer/load";
import type { ViewerProps } from "./viewer/Viewer";

// Its own chunk, loaded only once the page knows the guest's link. One that can't be fetched leaves
// the row out, never the album.
const PersonalLinkStrip = lazy<ComponentType<{ link: string }>>(() =>
  import("./PersonalLinkOffer")
    .then((module) => ({ default: module.PersonalLinkStrip }))
    .catch(() => ({ default: NothingShown })),
);

function NothingShown(): null {
  return null;
}

/** The viewer's props, with what the album hears when its chunk couldn't be fetched. */
type LazyViewerProps = ViewerProps & { onDidntLoad: () => void };

/**
 * The viewer, its own chunk: fetched at idle, and for certain on the first tap. A chunk that can't
 * be fetched never reaches the album's error page, which would take the whole album (and any
 * upload card) with it: ViewerDidntLoad stands in. React keeps a lazy's answer, so the album makes
 * a new one after a failure, and the next tap fetches the chunk again.
 */
function lazyViewer(): ComponentType<LazyViewerProps> {
  return lazy<ComponentType<LazyViewerProps>>(() =>
    loadViewer().then(
      (module) => ({ default: module.Viewer }),
      (error: unknown) => {
        function ViewerChunkFailed(props: LazyViewerProps) {
          return <ViewerDidntLoad {...props} error={error} />;
        }
        return { default: ViewerChunkFailed };
      },
    ),
  );
}

/**
 * Stands in for a viewer whose chunk couldn't be fetched. A script chunk (one a deploy removed, as
 * far as the page can tell) reloads the page once, to pick up the new one, unless a file is still
 * on its way from this page: a reload would stop it. Otherwise the viewer closes, as Back would,
 * and the album says why.
 */
function ViewerDidntLoad({ error, onRequestClose, onExited, onDidntLoad }: LazyViewerProps & { error: unknown }): null {
  const { busy } = use(AlbumUploadsContext);
  const handled = useRef(false);
  useEffect(() => {
    // Once, even where React runs an effect twice.
    if (handled.current) return;
    handled.current = true;
    if (!busy && reloadOnceForMissingChunk(error)) return;
    onRequestClose();
    onExited();
    onDidntLoad();
  }, [busy, error, onRequestClose, onExited, onDidntLoad]);
  return null;
}

/** How long the album says the viewer couldn't open. */
const VIEWER_TROUBLE_MILLISECONDS = 6_000;

type Whose = "everyone" | "mine";
type Filters = { celebration: AlbumCelebration | "all"; kind: AlbumKind | "all"; whose: Whose };

/** A filter's moments as far as the guest has scrolled. */
type Listing = AlbumPage & { loading: boolean; failed: boolean };

const keyOf = (filters: Filters) => `${filters.celebration}/${filters.kind}/${filters.whose}`;

function toFilter(filters: Filters): AlbumFilter {
  return {
    celebration: filters.celebration === "all" ? undefined : filters.celebration,
    kind: filters.kind === "all" ? undefined : filters.kind,
    mine: filters.whose === "mine",
  };
}

/** How often the album asks whether anything new has arrived, while the page is visible. */
const NEW_CHECK_MILLISECONDS = 30_000;
/** After a file of the guest's own is added, a sooner look, once the worker has had a moment. */
const AFTER_UPLOAD_CHECK_MILLISECONDS = 5_000;
/** The tiles above a phone's fold, loaded at once; the rest lazily. */
const EAGER_TILES = 9;
/** How far below the screen the next page starts loading. */
const LOAD_AHEAD = "1200px 0px";

const MOMENT_HASH = /^#m\/([0-9a-f-]{36})$/i;

/** The words when a filter has nothing (gate B screen 8). */
function emptyWords(filters: Filters): string {
  if (filters.whose === "mine") {
    if (filters.kind === "video") return "No videos from you yet. Tap Record video above to add one.";
    if (filters.kind === "photo") return "No photos from you yet. Tap Take a photo above to add one.";
    return "Nothing from this phone here yet. Share a moment above.";
  }
  return `No ${filters.kind === "photo" ? "photos" : filters.kind === "video" ? "videos" : "moments"} here yet.`;
}

/**
 * The viewer as it stands: which moment it opened on, the tile it grew from, whether it added a
 * history entry (Back then closes it), a moment opened by its link that isn't in the list, and
 * whether it is on its way out.
 */
type Opened = { id: string; tile: HTMLElement | null; pushed: boolean; loose: AlbumItem | null; closing: boolean };

function addressWithout(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * The album under its header (gate B): the celebration chips (More moments only once it holds
 * something), Everyone's moments or My uploads, Photos or Videos beside the count, and the grid,
 * newest first. The first page comes from the server; the next loads as the guest scrolls. Every
 * 30 s while the page is visible it asks whether anything new has arrived, and shows a pill rather
 * than shuffle the grid. A tapped moment opens in the viewer (its own chunk) at #m/<id>.
 */
export function AlbumBrowser({
  celebrations,
  firstPage,
  startMine,
  stats: startStats,
  personalLink: serverLink,
}: {
  /** The couple's celebrations, in their order. */
  celebrations: AlbumCelebration[];
  firstPage: AlbumPage;
  /** ?view=mine: My uploads first. */
  startMine: boolean;
  stats: AlbumStats;
  /** The guest's personal link, from the server; null for a browser without a guest. */
  personalLink: string | null;
}) {
  const [filters, setFilters] = useState<Filters>({ celebration: "all", kind: "all", whose: startMine ? "mine" : "everyone" });
  const [listings, setListings] = useState<Record<string, Listing>>(() => ({
    [keyOf({ celebration: "all", kind: "all", whose: startMine ? "mine" : "everyone" })]: { ...firstPage, loading: false, failed: false },
  }));
  const [stats, setStats] = useState(startStats);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = useState<Opened | null>(null);
  const [Viewer, setViewer] = useState(lazyViewer);
  const [viewerTrouble, setViewerTrouble] = useState(false);
  const [news, setNews] = useState<(NewCountAnswer & { key: string }) | null>(null);
  const clientLink = usePersonalLink();
  // The link learned last wins: the server's joins the page's store as it arrives (a fresh render,
  // after a navigation too), and a later answer from the uploader or a return to view replaces it.
  useLayoutEffect(() => {
    if (serverLink) setPersonalLink(serverLink);
  }, [serverLink]);
  const personalLink = clientLink ?? serverLink;
  useFreshGuestOnReturn(personalLink !== null);
  const uploads = use(AlbumUploadsContext);
  const gridTop = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const key = keyOf(filters);
  const filter = useMemo(() => toFilter(filters), [filters]);
  const listing = listings[key];
  const items = useMemo(() => listing?.items ?? [], [listing]);
  const viewable = useMemo(() => items.filter((item) => item.status === "ready"), [items]);
  const count = countFor(stats, filter);
  const withMore = celebrationsWithItems(stats).has("more") || filters.celebration === "more";
  const chips: (AlbumCelebration | "all")[] = ["all", ...celebrations.filter((id) => id !== "more"), ...(withMore ? (["more"] as const) : [])];

  const patchListing = useCallback((listingKey: string, change: (current: Listing | undefined) => Listing) => {
    setListings((current) => ({ ...current, [listingKey]: change(current[listingKey]) }));
  }, []);

  /** Every listing at once, a moment changed or gone. */
  const everyListing = useCallback((change: (moments: AlbumItem[]) => AlbumItem[]) => {
    setListings((current) => Object.fromEntries(Object.entries(current).map(([listingKey, value]) => [listingKey, { ...value, items: change(value.items) }])));
  }, []);

  // A filter's first page, the first time it is chosen (and again on Try again): until it comes, the
  // filter has no listing, which shows as loading.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (listings[key]) return;
    const controller = new AbortController();
    fetchPage(filter, null, controller.signal).then(
      (page) => patchListing(key, () => ({ ...page, loading: false, failed: false })),
      () => {
        if (!controller.signal.aborted) patchListing(key, () => ({ items: [], nextCursor: null, newestCursor: null, loading: false, failed: true }));
      },
    );
    return () => controller.abort();
    // Only when the filter changes, or the guest tries again: the listing it makes is what this checks for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    const current = listings[key];
    if (!current || current.loading || current.failed || !current.nextCursor) return;
    const cursor = current.nextCursor;
    patchListing(key, (value) => ({ ...(value as Listing), loading: true }));
    fetchPage(filter, cursor).then(
      (page) =>
        patchListing(key, (value) => {
          const known = new Set((value as Listing).items.map((item) => item.id));
          return { ...(value as Listing), items: [...(value as Listing).items, ...page.items.filter((item) => !known.has(item.id))], nextCursor: page.nextCursor, loading: false };
        }),
      () => patchListing(key, (value) => ({ ...(value as Listing), loading: false, failed: true })),
    );
  }, [listings, key, filter, patchListing]);

  // The next page, as the guest nears the end of this one.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !listing?.nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: LOAD_AHEAD });
    observer.observe(target);
    return () => observer.disconnect();
  }, [listing?.nextCursor, loadMore]);

  // The viewer's chunk, fetched while the page is idle.
  useEffect(() => prefetchViewerWhenIdle(), []);

  // The viewer's chunk didn't come: a new lazy, so the next tap fetches it again, and a word on why
  // nothing opened, for a few seconds.
  const viewerDidntLoad = useCallback(() => {
    setViewer(() => lazyViewer());
    setViewerTrouble(true);
  }, []);
  useEffect(() => {
    if (!viewerTrouble) return;
    const timer = window.setTimeout(() => setViewerTrouble(false), VIEWER_TROUBLE_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [viewerTrouble]);

  // New moments: asked every 30 s while the page is visible, and soon after one of the guest's own lands.
  const since = listing?.newestCursor ?? null;
  useEffect(() => {
    if (!since) return;
    const controller = new AbortController();
    let lastAsked = Date.now();
    const ask = () => {
      if (document.visibilityState !== "visible") return;
      lastAsked = Date.now();
      fetchNewCount(filter, since, controller.signal).then(
        (answer) => {
          if (answer && !controller.signal.aborted) setNews({ ...answer, key });
        },
        () => {},
      );
    };
    const timer = window.setInterval(ask, NEW_CHECK_MILLISECONDS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastAsked >= NEW_CHECK_MILLISECONDS) ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [since, key, filter]);

  const askSoon = useRef<number | null>(null);
  useEffect(() => {
    if (uploads.added === 0 || !since) return;
    if (askSoon.current) window.clearTimeout(askSoon.current);
    askSoon.current = window.setTimeout(() => {
      fetchNewCount(filter, since).then((answer) => answer && setNews({ ...answer, key }), () => {});
    }, AFTER_UPLOAD_CHECK_MILLISECONDS);
    return () => {
      if (askSoon.current) window.clearTimeout(askSoon.current);
    };
    // Only when another file has been added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads.added]);

  // The pill counts what isn't on the page already (a tile of the guest's own that turned ready here).
  const present = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const newCount = news && news.key === key ? news.count - (news.count <= news.newest.length ? news.newest.filter((moment) => present.has(moment.id)).length : 0) : 0;

  async function bringIn() {
    const since = listing?.newestCursor;
    if (!since) return;
    setNews(null);
    gridTop.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    try {
      const answer = await fetchNewer(filter, since);
      if (!answer.complete) {
        // Past 60 new: the first page again, and the counts with it.
        const { stats: counts, ...page } = await fetchFirstPageWithStats(filter);
        setFresh(new Set(page.items.filter((item) => !present.has(item.id)).map((item) => item.id)));
        setStats(counts);
        patchListing(key, () => ({ ...page, loading: false, failed: false }));
        return;
      }
      const arriving = answer.items.filter((item) => !present.has(item.id));
      setFresh(new Set(arriving.map((item) => item.id)));
      if (arriving.length > 0) setStats((current) => adjustStats(current, arriving, 1));
      patchListing(key, (value) => {
        const current = value as Listing;
        const waiting = current.items.filter((item) => item.status !== "ready");
        const listed = current.items.filter((item) => item.status === "ready");
        return { ...current, items: [...waiting, ...arriving, ...listed], newestCursor: answer.newestCursor ?? current.newestCursor };
      });
    } catch {
      // The pill comes back with the next check.
    }
  }

  // The guest's own moments being made ready ask after themselves (one shared check for them all),
  // and turn ready, or failed, in place; one that has gone leaves.
  const waitingIds = useMemo(() => items.filter((item) => item.status === "uploaded").map((item) => item.id), [items]);
  useWaitingTiles(waitingIds, (mediaId, item) => {
    if (item === null) everyListing((moments) => moments.filter((moment) => moment.id !== mediaId));
    else everyListing((moments) => moments.map((moment) => (moment.id === mediaId ? item : moment)));
  });

  // The viewer, by the address: #m/<id> opens it (a moment's own link, or Back to it), anything else closes it.
  const openById = useCallback(
    async (mediaId: string, pushed: boolean) => {
      const tile = document.querySelector<HTMLElement>(`[data-moment="${CSS.escape(mediaId)}"]`);
      setViewerTrouble(false);
      if (viewable.some((item) => item.id === mediaId)) {
        setOpened({ id: mediaId, tile, pushed, loose: null, closing: false });
        return;
      }
      const item = await fetchItem(mediaId).catch(() => null);
      if (item && item.status === "ready") setOpened({ id: mediaId, tile: null, pushed, loose: item, closing: false });
      else if (MOMENT_HASH.test(window.location.hash)) window.history.replaceState(null, "", addressWithout());
    },
    [viewable],
  );

  // A moment's own link (#m/<id>) opens it once the page has come to life.
  useEffect(() => {
    const match = MOMENT_HASH.exec(window.location.hash);
    if (!match) return;
    const timer = window.setTimeout(() => void openById(match[1].toLowerCase(), false), 0);
    return () => window.clearTimeout(timer);
    // Once, as the page loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPop = () => {
      const match = MOMENT_HASH.exec(window.location.hash);
      if (!match) setOpened((current) => (current ? { ...current, closing: true } : null));
      else if (match[1].toLowerCase() !== opened?.id) void openById(match[1].toLowerCase(), false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [opened?.id, openById]);

  function openTile(item: AlbumItem, tile: HTMLElement) {
    window.history.pushState(null, "", `${addressWithout()}#m/${item.id}`);
    setViewerTrouble(false);
    setOpened({ id: item.id, tile, pushed: true, loose: null, closing: false });
  }

  const loose = opened?.loose ?? null;
  const viewerItems = useMemo(() => {
    if (!loose) return viewable;
    return viewable.some((item) => item.id === loose.id) ? viewable : [loose];
  }, [viewable, loose]);

  function chooseFilters(next: Partial<Filters>) {
    const changed = { ...filters, ...next };
    setFilters(changed);
    setFresh(new Set());
    if (next.whose) {
      const query = new URLSearchParams(window.location.search);
      if (next.whose === "mine") query.set("view", "mine");
      else query.delete("view");
      const search = query.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    }
  }

  const mine = filters.whose === "mine";
  const loading = !listing;

  return (
    <>
      <nav aria-label="Celebrations" className="album-chips no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pt-5.5 pb-1">
        {chips.map((chip) => {
          const on = chip === filters.celebration;
          return (
            <button
              key={chip}
              type="button"
              aria-pressed={on}
              onClick={() => chooseFilters({ celebration: chip })}
              className={`min-h-11 shrink-0 cursor-pointer rounded-full border px-5 text-xs uppercase tracking-[0.14em] transition-[background-color,box-shadow,color,border-color] duration-200 ${
                on ? "border-white bg-white text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.08),0_6px_14px_rgb(61_41_39/0.1)]" : "border-stone bg-transparent text-mocha"
              }`}
            >
              {chip === "all" ? "All" : CELEBRATION_LABELS[chip]}
            </button>
          );
        })}
      </nav>
      <div className={`fold ${filters.celebration === "more" ? "" : "is-folded"}`}>
        <div>
          <p className="m-0 px-0.5 pt-2.5 font-serif text-[17px] leading-[1.35] text-mocha italic">From outside the celebrations, like the night before or the morning after.</p>
        </div>
      </div>

      <Segmented
        label="Whose moments"
        value={filters.whose}
        onChange={(whose: Whose) => chooseFilters({ whose })}
        options={[
          { value: "everyone", label: "Everyone's moments" },
          { value: "mine", label: "My uploads" },
        ]}
        className="mt-3.5 sm:max-w-md"
      />

      <div ref={gridTop} className="flex scroll-mt-4 items-center justify-between gap-3 py-2.5">
        <p className="m-0 text-[13px] text-mocha" aria-live="polite">
          {countWords(count, filter.kind)}
        </p>
        <TypeTabs value={filters.kind} onChange={(kind) => chooseFilters({ kind })} />
      </div>

      {mine && personalLink ? (
        <Suspense fallback={null}>
          <PersonalLinkStrip link={personalLink} />
        </Suspense>
      ) : null}

      {newCount > 0 && news && !viewerTrouble ? <NewMomentsPill count={newCount} newest={news.newest} onShow={bringIn} /> : null}
      <div role="status" className="sticky top-3 z-10 flex h-0 justify-center">
        {viewerTrouble ? (
          <p className="m-0 mt-1.5 max-w-[calc(100%-2rem)] rounded-2xl bg-cocoa px-4 py-2.5 text-center text-[13px] leading-snug text-white shadow-[var(--shadow-pill-cocoa)]">
            Couldn&apos;t open this moment. Check your connection and try again.
          </p>
        ) : null}
      </div>

      {loading ? (
        <TilesLoading />
      ) : listing.failed && items.length === 0 ? (
        <AlbumTrouble
          onRetry={() => {
            setListings((current) => Object.fromEntries(Object.entries(current).filter(([listingKey]) => listingKey !== key)));
            setAttempt((count) => count + 1);
          }}
        />
      ) : items.length === 0 ? (
        <p className="m-0 rounded-[var(--radius-paper)] bg-white px-5 py-9 text-center font-serif text-xl text-balance text-mocha italic shadow-[var(--shadow-paper)]">
          {emptyWords(filters)}
        </p>
      ) : (
        <ul aria-label="Moments" className="album-grid">
          {items.map((item, index) => (
            <MediaTile
              key={item.id}
              item={item}
              eager={index < EAGER_TILES}
              fresh={fresh.has(item.id)}
              onOpen={openTile}
              onSendAgain={uploads.sendAgain}
            />
          ))}
        </ul>
      )}
      <div ref={sentinel} aria-hidden className="h-px" />
      {listing?.loading && listing.items.length > 0 ? (
        <p role="status" className="m-0 py-4 text-center text-xs text-mocha">
          Loading more moments…
        </p>
      ) : listing?.failed && listing.items.length > 0 ? (
        <p className="m-0 flex items-center justify-center gap-3 py-4 text-xs text-mocha">
          More moments didn&apos;t load.
          <button type="button" onClick={() => patchListing(key, (value) => ({ ...(value as Listing), failed: false }))} className="ember-link min-h-11 cursor-pointer border-0 bg-transparent p-0 text-xs uppercase tracking-[0.14em] text-cocoa">
            Try again
          </button>
        </p>
      ) : null}

      {items.some((item) => item.mine) ? (
        <p className="mt-3 mb-0 flex items-center gap-2 text-xs text-mocha">
          <span aria-hidden className="size-2.5 rounded-full border-2 border-white bg-ember shadow-[0_0_0_1px_var(--color-hairline)]" />
          Marks your own uploads
        </p>
      ) : null}

      {opened ? (
        <Suspense fallback={null}>
          <Viewer
            // A moment opened by its link while another was open (a hash change) starts afresh.
            key={opened.id}
            items={viewerItems}
            startId={opened.id}
            tile={opened.tile}
            total={opened.loose && viewerItems.length === 1 ? 1 : Math.max(viewerItems.length, listing?.nextCursor ? count : viewerItems.length)}
            closing={opened.closing}
            onMove={(mediaId) => window.history.replaceState(null, "", `${addressWithout()}#m/${mediaId}`)}
            onNearEnd={loadMore}
            onRequestClose={() => {
              if (opened.closing) return;
              if (opened.pushed) window.history.back();
              else {
                window.history.replaceState(null, "", addressWithout());
                setOpened((current) => (current ? { ...current, closing: true } : null));
              }
            }}
            onExited={() => setOpened(null)}
            onDidntLoad={viewerDidntLoad}
            onChanged={(item) => everyListing((moments) => moments.map((moment) => (moment.id === item.id ? item : moment)))}
            onRemoved={(item) => {
              everyListing((moments) => moments.filter((moment) => moment.id !== item.id));
              setStats((current) => adjustStats(current, [item], -1));
            }}
            tileOf={(mediaId) => document.querySelector<HTMLElement>(`[data-moment="${CSS.escape(mediaId)}"]`)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** All · Photos · Videos, on the count's row (gate B screen 8): the chosen one opens to show its word. */
function TypeTabs({ value, onChange }: { value: AlbumKind | "all"; onChange: (kind: AlbumKind | "all") => void }) {
  const tabs: { kind: AlbumKind | "all"; label: string; word: string | null }[] = [
    { kind: "all", label: "Photos and videos", word: null },
    { kind: "photo", label: "Photos only", word: "Photos" },
    { kind: "video", label: "Videos only", word: "Videos" },
  ];
  return (
    <div role="group" aria-label="Show" className="type-tabs">
      {tabs.map((tab) => (
        <button key={tab.kind} type="button" aria-pressed={value === tab.kind} aria-label={tab.label} onClick={() => onChange(tab.kind)}>
          {tab.kind === "all" ? "All" : tab.kind === "photo" ? <Icon name="image" size={17} /> : <PlayGlyph size={13} />}
          {tab.word ? (
            <span className="type-label" aria-hidden>
              {tab.word}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** "N new moments", held at the top of the grid while the guest scrolls; tapping brings them in. */
function NewMomentsPill({ count, newest, onShow }: { count: number; newest: NewCountAnswer["newest"]; onShow: () => void }) {
  const words = newMomentsWords(count);
  return (
    <div className="sticky top-3 z-10 flex h-0 justify-center">
      <button type="button" onClick={onShow} aria-label={`Show ${words}`} className="new-pill press">
        <span className="flex pl-1" aria-hidden>
          {newest.slice(0, 3).map((moment) => (
            <span
              key={moment.id}
              className="-ml-2 size-7.5 rounded-full bg-cover bg-center shadow-[0_0_0_2px_var(--color-cocoa)] first:ml-0"
              style={{ backgroundColor: moment.color ?? undefined, backgroundImage: moment.thumb ? `url(${moment.thumb})` : undefined }}
            />
          ))}
        </span>
        <span>{words}</span>
        <Icon name="arrowUp" size={16} className="text-ember" />
      </button>
    </div>
  );
}

function TilesLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the album" className="album-grid">
      {Array.from({ length: 9 }, (_tile, position) => (
        <div key={position} className="aspect-square animate-pulse rounded-[2px] bg-tile" />
      ))}
    </div>
  );
}

function AlbumTrouble({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-paper)] bg-white px-5 py-8 text-center shadow-[var(--shadow-paper)]">
      <p className="m-0 font-serif text-xl text-mocha italic">The album can&apos;t load right now.</p>
      <button type="button" onClick={onRetry} className="ember-link min-h-11 cursor-pointer border-0 bg-transparent p-0 text-xs uppercase tracking-[0.16em] text-cocoa">
        Try again
      </button>
    </div>
  );
}
