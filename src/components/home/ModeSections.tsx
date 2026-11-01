import { couple } from "@/content/wedding";
import { accraDayAndMonth } from "@/lib/accra";
import type { Celebration, ScheduleItem, SiteContent } from "@/lib/content/schema";
import type { Wish } from "@/lib/data/types";
import { listWishes } from "@/lib/data/wishes";
import { readGuestIds } from "@/lib/guests/cookie";
import { describeError } from "@/lib/log-error";
import { albumStats, countSharers, listAlbum } from "@/lib/media/album";
import { albumSummaryWords, countFor, countWords, type AlbumItem } from "@/lib/media/album-item";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Halo } from "@/components/ui/Halo";
import { PlayGlyph } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { Eyebrow, Ornament, SectionHeading } from "@/components/ui/Typography";
import { AlbumBrowser } from "@/components/album/AlbumBrowser";
import { OrderOfDay } from "@/components/today/OrderOfDay";
import { TextWish, VideoWish, VoiceWish } from "@/components/wishes/WishCards";

function Perks() {
  return (
    <div className="my-1 flex flex-wrap gap-x-6.5 gap-y-2.5 font-serif text-[19px]">
      <span className="flex items-center gap-2.5"><Halo icon="phone" size="sm" />No app</span>
      <span className="flex items-center gap-2.5"><Halo icon="user" size="sm" />No sign-up</span>
      <span className="flex items-center gap-2.5"><Halo icon="download" size="sm" />Keep your own</span>
    </div>
  );
}

/** How long ago a moment was shared, as the "Just shared" card says it. */
function sharedAgo(listedAt: string | null, now: number): string {
  if (!listedAt) return "just now";
  const minutes = Math.floor((now - Date.parse(listedAt)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return accraDayAndMonth(new Date(listedAt));
}

/**
 * Wedding weekend: the album, straight under the hero, with the five newest moments (each opens in
 * the album's viewer) and how many there are, how long ago measured from `now`, the request's time. When the album can't be read, the card says nothing
 * has been shared rather than take the home page down.
 */
export async function LiveAlbum({ now }: { now: number }) {
  let recent: AlbumItem[] = [];
  let total = 0;
  try {
    const [page, stats] = await Promise.all([listAlbum({ viewerGuestIds: [], limit: 5 }), albumStats()]);
    recent = page.items;
    total = countFor(stats, {});
  } catch (error) {
    console.error("[home] could not read the album:", describeError(error));
  }
  const more = total - recent.length;
  return (
    <section id="album" className="bg-tray px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1160px] flex-col items-center gap-14 lg:flex-row lg:gap-16">
        <div className="flex flex-1 flex-col gap-5">
          <Eyebrow className="flex items-center gap-3">
            <span className="live-dot" aria-hidden />
            Live album · {couple.hashtag}
          </Eyebrow>
          <h2 className="m-0 font-script text-[56px] leading-none font-normal sm:text-[84px]">Share a moment</h2>
          <p className="m-0 font-serif text-xl leading-[1.65] text-mocha sm:text-[22px]">
            Snap it, share it. Your photos and videos appear here for everyone to enjoy, and you can download your own
            whenever you like.
          </p>
          <Perks />
          <div className="mt-1.5 flex flex-col items-start gap-x-6.5 gap-y-2 sm:flex-row sm:flex-wrap sm:items-center">
            <PillLink href="/album" variant="emberLight" icon="camera">
              Take a photo or video
            </PillLink>
            <TextLink href="/album">Upload from your phone</TextLink>
            <TextLink href="/wishes">Leave a wish</TextLink>
          </div>
        </div>
        <Reveal
          className="flex w-full flex-1 flex-col gap-4 rounded-[var(--radius-paper)] bg-white px-4 pt-5 pb-4 shadow-[0_1px_2px_rgb(61_41_39/0.06),0_18px_40px_rgb(61_41_39/0.1)] sm:px-6 sm:pt-6"
          style={{ transform: "rotate(0.8deg)" }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-serif text-[28px] italic">Just shared</span>
            <span className="text-[11px] uppercase tracking-[0.2em] text-mocha">{countWords(total, undefined)} so far</span>
          </div>
          {recent.length ? (
            <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
              {recent.map((item, index) => (
                <a
                  key={item.id}
                  href={`/album#m/${item.id}`}
                  aria-label={`${item.kind === "video" ? "Video" : "Photo"} shared by ${item.by ?? "a guest"}`}
                  className="relative m-0 block aspect-square overflow-hidden rounded-sm bg-tile no-underline"
                  style={item.color ? { backgroundColor: item.color } : undefined}
                >
                  {item.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
                    <img src={item.thumb} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
                  ) : null}
                  {item.kind === "video" ? (
                    <span aria-hidden className="absolute top-1/2 left-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/92 text-cocoa">
                      <PlayGlyph size={13} />
                    </span>
                  ) : null}
                  <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-white/94 px-2.5 py-1 text-[11px] tracking-wide text-cocoa">
                    {index === 0 ? <span className="live-dot !size-1.5" aria-hidden /> : null}
                    {sharedAgo(item.listedAt, now)}
                  </span>
                </a>
              ))}
              <a
                href="/album"
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-sm bg-tray text-center no-underline"
              >
                {more > 0 ? <span className="font-serif text-[30px] leading-none">+{more}</span> : null}
                <span className="ember-link pb-0.5 text-[11px] uppercase tracking-[0.2em] text-mocha">See all</span>
              </a>
            </div>
          ) : (
            <p className="m-0 py-10 text-center font-serif text-xl text-mocha italic">Be the first to share a moment.</p>
          )}
        </Reveal>
      </div>
    </section>
  );
}

/** Wedding weekend: the order of the day and directions. */
export function TodaySection({
  todayLabel,
  secondDay,
  schedule,
  venues,
  liveUrl,
}: {
  todayLabel: string;
  secondDay: boolean;
  schedule: ScheduleItem[];
  venues: SiteContent["venues"];
  /** Set only once the live stream is showing. */
  liveUrl: string | null;
}) {
  return (
    <section id="today" className="bg-white px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-12 sm:gap-14">
        <Reveal className="flex flex-col items-center gap-3 text-center">
          <Eyebrow>{todayLabel}</Eyebrow>
          <h2 className="m-0 font-script text-[56px] leading-none font-normal sm:text-[84px]">Today</h2>
          <Ornament />
        </Reveal>
        <div className="flex flex-col gap-12 lg:flex-row lg:items-start lg:gap-16">
          <div className="min-w-0 flex-1">
            <h3 className="mt-0 mb-3.5 font-serif text-[30px] font-normal italic sm:text-[34px]">Order of the day</h3>
            <OrderOfDay schedule={schedule} venues={venues} secondDay={secondDay} />
          </div>
          <Reveal className="flex min-w-0 flex-col gap-5.5 rounded-[var(--radius-paper)] bg-tray p-4 sm:p-7 lg:w-[420px] lg:flex-none">
            <div className="flex flex-wrap justify-center gap-x-7 gap-y-1">
              <a
                href={venues.reception.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ember-link inline-flex min-h-11 items-center text-xs uppercase tracking-[0.16em] no-underline"
              >
                Directions to the reception
              </a>
              {liveUrl ? (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ember-link inline-flex min-h-11 items-center text-xs uppercase tracking-[0.16em] no-underline"
                >
                  Watch live
                  <span className="sr-only"> (opens the live stream)</span>
                </a>
              ) : null}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/**
 * After the wedding: the whole album, filterable, as the album page shows it, under a line counting
 * what everyone sees in it (its photos and videos) and how many guests shared them. Downloading
 * everything, or all of one's own, comes with Plan 3's zips.
 */
export async function AfterAlbum({ celebrations }: { celebrations: Celebration[] }) {
  const guestIds = await readGuestIds();
  let album: Awaited<ReturnType<typeof listAlbum>> | null = null;
  let counts: Awaited<ReturnType<typeof albumStats>> | null = null;
  let sharers = 0;
  try {
    [album, counts, sharers] = await Promise.all([listAlbum({ viewerGuestIds: guestIds }), albumStats(guestIds), countSharers()]);
  } catch (error) {
    console.error("[home] could not read the album:", describeError(error));
  }
  const summary = albumSummaryWords(
    counts && { photos: countFor(counts, { kind: "photo" }), videos: countFor(counts, { kind: "video" }), sharers },
  );
  return (
    <section id="album" className="bg-tray py-20 sm:py-26">
      {/* Its side padding on the column, so the chip row can run into it as it scrolls (as on the album page). */}
      <div className="mx-auto flex max-w-[1148px] flex-col gap-6 px-4 sm:px-6">
        <div className="flex flex-col gap-3.5 px-1">
          <Eyebrow>Our shared album</Eyebrow>
          <h2 className="m-0 font-script text-[56px] leading-none font-normal sm:text-[84px]">Every moment</h2>
          <p className="m-0 font-serif text-xl leading-relaxed text-mocha sm:text-[22px]">{summary}</p>
        </div>
        {album && counts ? (
          // One block in the column (not one gap per row), with room in its own padding for the chip
          // row to run into as it scrolls.
          <div className="-mx-4 px-4">
            <AlbumBrowser
              celebrations={celebrations.map((celebration) => celebration.id)}
              firstPage={album}
              startMine={false}
              stats={counts}
              personalLink={null}
            />
          </div>
        ) : (
          <p className="m-0 text-center font-serif text-xl text-mocha italic">The album can&apos;t load right now. Try again in a minute.</p>
        )}
      </div>
    </section>
  );
}

/**
 * After the wedding: the guestbook wall. When the wishes can't be read, the wall says so and the
 * rest of the home page still shows.
 */
export async function WishesWall() {
  let wishes: Wish[] | null;
  try {
    // A guest's own recorded wishes show to them while they are made ready (Ruling BR).
    wishes = await listWishes(await readGuestIds());
  } catch (error) {
    console.error("[home] could not read the wishes:", describeError(error));
    wishes = null;
  }
  return (
    <section id="wishes" className="bg-white px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-12 sm:gap-14">
        <Reveal>
          <SectionHeading eyebrow="Our guestbook" title="Your wishes" lead="Words we'll be reading for years to come." />
        </Reveal>
        {wishes === null ? (
          <p className="m-0 text-center font-serif text-xl text-mocha italic">
            The wishes can&apos;t load right now. Try again in a minute.
          </p>
        ) : wishes.length ? (
          <div className="columns-1 gap-7 sm:columns-2 lg:columns-3">
            {wishes.map((wish, index) => (
              <div key={wish.id} className="mb-7 break-inside-avoid">
                {wish.kind === "voice" ? (
                  <VoiceWish wish={wish} index={index} />
                ) : wish.kind === "video" ? (
                  <VideoWish wish={wish} index={index} />
                ) : (
                  <TextWish wish={wish} index={index} />
                )}
              </div>
            ))}
          </div>
        ) : (
          // No wishes yet: the button below leads to the guestbook.
          <p className="m-0 text-center font-serif text-xl text-mocha italic">Be the first to leave a wish.</p>
        )}
        <div className="flex justify-center">
          <PillLink href="/wishes" variant="cocoa">
            Leave a wish
          </PillLink>
        </div>
      </div>
    </section>
  );
}
