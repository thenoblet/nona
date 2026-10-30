import { couple } from "@/content/wedding";
import type { Celebration, ScheduleItem, Venue } from "@/lib/content/schema";
import { listMedia, mediaStats, SAMPLE_DEVICE } from "@/lib/data/media";
import { listWishes } from "@/lib/data/wishes";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Halo } from "@/components/ui/Halo";
import { PlayGlyph } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { Eyebrow, Ornament, SectionHeading } from "@/components/ui/Typography";
import { MediaImage } from "@/components/album/MediaImage";
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

/** Wedding weekend: the album, straight under the hero, with the newest uploads. */
export async function LiveAlbum() {
  const [recent, stats] = await Promise.all([listMedia(), mediaStats()]);
  const tiles = recent.filter((m) => m.src).slice(0, 5);
  const ago = ["just now", "2 min ago", "5 min ago", "9 min ago", "12 min ago"];
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
            <span className="text-[11px] uppercase tracking-[0.2em] text-mocha">{stats.today} moments so far</span>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
            {tiles.map((m, i) => (
              <figure key={m.id} className="relative m-0 aspect-square overflow-hidden rounded-sm bg-tile">
                <MediaImage item={m} sizes="(min-width: 1024px) 180px, 30vw" />
                {m.kind === "video" ? (
                  <span aria-hidden className="absolute top-1/2 left-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/92 text-cocoa">
                    <PlayGlyph size={13} />
                  </span>
                ) : null}
                <figcaption className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-white/94 px-2.5 py-1 text-[11px] tracking-wide">
                  {i === 0 ? <span className="live-dot !size-1.5" aria-hidden /> : null}
                  {ago[i]}
                </figcaption>
              </figure>
            ))}
            <a
              href="/album"
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-sm bg-tray text-center no-underline"
            >
              <span className="font-serif text-[30px] leading-none">+[80]</span>
              <span className="ember-link pb-0.5 text-[11px] uppercase tracking-[0.2em] text-mocha">See all</span>
            </a>
          </div>
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
  reception,
  liveUrl,
}: {
  todayLabel: string;
  secondDay: boolean;
  schedule: ScheduleItem[];
  reception: Venue;
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
            <OrderOfDay schedule={schedule} secondDay={secondDay} />
          </div>
          <Reveal className="flex min-w-0 flex-col gap-5.5 rounded-[var(--radius-paper)] bg-tray p-4 sm:p-7 lg:w-[420px] lg:flex-none">
            <div className="flex flex-wrap justify-center gap-x-7 gap-y-1">
              <a
                href={reception.mapsUrl}
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

/** After the wedding: the whole album, filterable, with downloads. */
export async function AfterAlbum({ celebrations }: { celebrations: Celebration[] }) {
  const [items, stats] = await Promise.all([listMedia(), mediaStats()]);
  return (
    <section id="album" className="bg-tray px-4 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
        <div className="flex flex-col gap-6 px-1 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-3.5">
            <Eyebrow>Our shared album</Eyebrow>
            <h2 className="m-0 font-script text-[56px] leading-none font-normal sm:text-[84px]">Every moment</h2>
            <p className="m-0 font-serif text-xl leading-relaxed text-mocha sm:text-[22px]">
              {stats.moments} photos and videos from {stats.guests} of you, all in one place.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6.5 gap-y-2">
            {/* TODO: link to the per-celebration zip files built after each event. */}
            <PillLink href="/album" variant="cocoa" icon="download">
              Download everything
            </PillLink>
            <TextLink href="/album">Download mine</TextLink>
          </div>
        </div>
        <AlbumBrowser celebrations={celebrations} items={items} myDevice={SAMPLE_DEVICE} />
        <p className="m-0 flex items-center gap-3 px-1 font-serif text-[19px] text-mocha">
          <Halo icon="phone" size="sm" />
          Your own uploads are remembered on your phone, so &ldquo;Download mine&rdquo; gives you exactly yours.
        </p>
      </div>
    </section>
  );
}

/** After the wedding: the guestbook wall. */
export async function WishesWall() {
  const wishes = await listWishes();
  return (
    <section id="wishes" className="bg-white px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-12 sm:gap-14">
        <Reveal>
          <SectionHeading eyebrow="Our guestbook" title="Your wishes" lead="Words we'll be reading for years to come." />
        </Reveal>
        <div className="columns-1 gap-7 sm:columns-2 lg:columns-3">
          {wishes.map((w, i) => (
            <div key={w.id} className="mb-7 break-inside-avoid">
              {w.kind === "voice" ? (
                <VoiceWish wish={w} index={i} />
              ) : w.kind === "video" ? (
                <VideoWish wish={w} index={i} />
              ) : (
                <TextWish wish={w} index={i} />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-center">
          <PillLink href="/wishes" variant="cocoa">
            Leave a wish
          </PillLink>
        </div>
      </div>
    </section>
  );
}
