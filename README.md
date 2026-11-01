# NONA'26

The wedding website for Noblet & Nancy: the invitation, RSVP, a shared photo and video
album guests use from their phones (no app, no sign-up), a guestbook, a wedding-day screen, and a
slideshow of guests' photos for the venue TV that also works on phones.

Mobile-first: every page is designed for a phone, then widened for larger screens.

## Pages

| Route | What it is |
|---|---|
| `/` | Landing page (editorial cover). "Open the invitation" starts the music and opens `/home`. |
| `/home` | The homepage. The date picks one of three versions: **before** (the invitation), **wedding weekend** (5 and 6 Dec: photo sharing and today's schedule) and **after** (thank you, full album, wishes). |
| `/rsvp` | Reply form. A confirmation email follows, with calendar files (`/calendar`). |
| `/album` | The shared album the table QR codes open. |
| `/wishes` | Guestbook: written, voice or video wishes. |
| `/today` | Wedding-day screen: what's happening now, the schedule, quick actions. |
| `/open` | Envelope opener, an optional phone entry with a wax seal. |
| `/slideshow` | Guests' newest photos. On the venue TV (and any landscape screen): the photo, a QR code to the album and the latest thumbnails. On a phone held upright: the photo full screen; swipe or tap the sides to move, with pause, close and "Add yours". |
| `/print/table-card?table=7` | Printable A5 QR card for each table. |
| `/admin` | The couple's admin, behind Cloudflare Access. Opens on the replies. |
| `/admin/rsvps` | Every current reply, with totals per celebration, search, filters, each reply's confirmation email ("Sent", "Sending", "Not sent", "Failed" or "No email") and the replies to check ("Keep this one", "Keep both"). |
| `/admin/rsvps.csv` | The replies as a spreadsheet (CSV), times in Accra. |
| `/admin/content/[section]` | Edit the site's times, venues and text, one section at a time (`celebrations`, `schedule`, `venues`, `landmarks`, `faq`, `travel`, `gifts`, `party`, `story`, `live-stream`), with every saved version kept for undo. |

### Previewing the homepage versions

In development, add `?mode=day` or `?mode=after` to `/home`. In production this only works
when `ALLOW_MODE_PREVIEW=true`; on the live site, leave it unset so the date always decides
(Ghana time, GMT all year: the wedding weekend starts 5 Dec 00:00, the thank-you version 7 Dec 00:00).

## Project layout

```
src/
  app/                 routes (see above); (site)/ shares the floating music player
  components/
    ui/                buttons, halo icons, paper cards, fields, segmented switch, reveal
    music/             MusicProvider (songs play across pages), MusicPlayer, Dock
    home/              homepage sections
    album/ wishes/ rsvp/ today/ open/ slideshow/ landing/ layout/
  content/             the words and facts you edit: wedding.ts, songs.ts, images.ts
  lib/
    mode.ts            before / wedding weekend / after
    db/ content/       Postgres client, schema, migrations; editable site content
    data/              rsvp.ts (Postgres), media.ts and wishes.ts (stand-ins, see below)
    email/ jobs/       confirmation emails (Resend), sent from a pg-boss job queue
    storage/           Cloudflare R2 (MinIO locally): object keys, multipart uploads, manifests
    media/             the upload API's work and the media table's queries
  worker/              the media worker, a process and image of its own (see below)
    calendar/          calendar files for each celebration
    qr.ts              album QR codes
  fonts/               self-hosted fonts (no request to Google)
public/
  images/              story photos and flowers
  audio/               the three songs, .webm + .mp3 (mp3 for older iPhones)
```

**The couple change times, venues and text in the admin (`/admin/content`).** A saved section
shows on the site within seconds. `src/content/wedding.ts` holds the built-in text: the site
shows it for a section until that section is first saved in the admin, and for every section
whenever the database can't be reached. Once a section has been saved, editing `wedding.ts` no
longer changes it on the site. Anything still to confirm is in square brackets, like
`[Start time]` and `[Guest hotel]`.

## Data: Postgres, and what is still a stand-in

RSVPs, the site's editable content (times, venues, text) and written wishes are stored in
Postgres, beside the tables the album will use: guests, media, site images, upload events and
settings (`src/lib/db/schema.ts`). Schema migrations (`drizzle/`) run at server start. A new
database starts with guest uploads closed (`uploads_open` is false), so no deploy opens them before
the couple do.
Confirmation emails go out through Resend from a pg-boss job queue, never in the request itself.
A reply whose confirmation never reached the queue (at most three a day go to one address, or the
server restarted at the wrong moment) shows as "Not sent"; when the queue starts, it tries the
last day's again.

The album is still a stub with its final function signatures, so the pages won't change when the
real backend arrives: `listMedia` and `mediaStats` in `src/lib/data/media.ts` return a fixed set
of sample photos. Next: the media rows, with their files in Cloudflare R2. Voice and video wishes
are next too.

Search for `TODO` to find the other placeholders: uploads (presigned multipart to R2), downloads
(per-celebration zips, built by a separate media worker), voice and video recording, the device
cookie for "My uploads", and live updates for the album (`src/app/(site)/album/page.tsx`: it will
poll every 30 s, as the slideshow already does).

When guest media is served from R2, add its host to `images.remotePatterns` in `next.config.ts`.

## The venue TV

Open `/slideshow` in Chrome or Edge on the laptop plugged into the TV, then press **F** (or move
the mouse and click the full-screen button). It runs on its own all evening:

- the screen is kept awake while the page is open (Screen Wake Lock), and the pointer and the
  controls fade away after a few seconds without movement;
- it asks for new photos every 30 s; if the network drops it keeps showing what it has and tries
  again, and a photo that fails to load is skipped;
- keys: **←** and **→** move, **space** pauses, **F** toggles full screen.

Set the laptop itself never to sleep as well: the wake lock only holds while the tab is visible.

## Develop

```bash
npm install
cp .env.example .env.local      # local settings; the Postgres and MinIO values match docker compose
docker compose up -d db minio   # local Postgres, and MinIO standing in for R2
npm run storage:init            # creates MinIO's two buckets (safe to run again)
npm run seed                    # optional: sample photos and wishes, and opens uploads (safe to run again)
npm run dev                     # http://localhost:3000
npm run lint
npm run build
```

### Tests

```bash
docker compose up -d db minio
npm run storage:init
npm test             # Vitest, against the nona_test database and MinIO
npm run test:e2e     # Playwright, against a production build on port 3100
```

The e2e run starts the media worker beside the site: its production image (`Dockerfile.worker`'s
`run` target), built from your checkout as it starts (`nona-worker-e2e`; Docker's cache makes later
runs quick) and run on the host's network as `nona-e2e-worker`, removed when the run ends (its log
is kept in `test-results/worker.log`). CI builds the image first and names it in `E2E_WORKER_IMAGE`.

The media worker's tests (`npm run test:worker`, `src/worker/`) run ffmpeg and libheif's tools, so
they run in the worker image's test target, against the same database and MinIO:

```bash
docker build -f Dockerfile.worker --target test -t nona-worker-test .
docker run --rm --network host nona-worker-test
```

Without `RESEND_API_KEY`, development only logs the email instead of sending it.

### Email preview

```bash
npm run email:preview   # http://localhost:3030, the templates in src/emails with sample replies
```

The preview tooling pins exact versions, so upgrade it as a set:

- `react-email` and `@react-email/ui` must stay on the same exact version.
- `@react-email/ui` pins an exact `next`. When upgrading Next, bump `next`, `eslint-config-next`,
  `react-email` and `@react-email/ui` together, to a `react-email` release whose `@react-email/ui`
  pins that `next`.
- `@react-email/render`, which renders the real emails, is pinned too: `react-email` accepts any
  version from 2.2.0 up, and a new one could change the html guests receive.

Built with Next.js 16 (App Router, Cache Components), React 19, TypeScript and Tailwind CSS 4.
Colours and shadows are Tailwind tokens in `src/app/globals.css` (`cocoa`, `mocha`, `ember`,
`blush`, `tray`, `halo`, `hairline`, ...).

## Deploy (Dokploy)

The `Dockerfile` builds a standalone Next.js server. Nothing is built on the server: on every push
to `main`, GitHub Actions (`.github/workflows/image.yml`) builds the image and pushes it to
`ghcr.io/thenoblet/nona` as `:latest` and `:sha-<short>`.

In LuxBedding's Dokploy, the app runs from that Docker image on `nona-web-01`, with port `3000`, health
check `GET /api/healthz`, and these environment variables. Their values live in Dokploy only, never
in this repository.

| Variable | What it is |
|---|---|
| `SITE_URL` | The public address, `https://nobletxnancy.com`, without a trailing slash. Used in QR codes, emails, calendar files and link previews; also passed to the build, because static pages bake it in. |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | The database on the private network. Without them the site shows its built-in text, but replies, the admin and emails are off. |
| `GUEST_COOKIE_SECRET` | Signs the cookie that recognises a guest's browser: at least 32 random bytes (`openssl rand -base64 32`). Without it, every page and route that reads the guest cookie fails. Changing it forgets every browser's guests; their personal links bring them back. |
| `RESEND_API_KEY` | Sends the confirmation emails. Without it, or once Resend's daily limit is reached, a confirmation shows "Sending" in the admin for about 24 to 28 hours of retries, then ends "Failed"; it never claims to have sent. |
| `EMAIL_FROM` | The sender: a name and an address on a domain verified in Resend. Optional; it defaults to the RSVP address in `src/lib/email/send.ts`. |
| `EMAIL_REPLY_TO` | Where a guest's reply to the email goes. Several addresses, separated by commas, all receive it. |
| `CF_ACCESS_TEAM_DOMAIN` | The Cloudflare Access team domain as a bare host (`<team>.cloudflareaccess.com`, without `https://`). |
| `CF_ACCESS_AUD` | The Access application's audience tag. With either of these two missing, the admin refuses everyone. |

**Never set `ADMIN_DEV_EMAIL` or `ALLOW_MODE_PREVIEW` in production.** The first stands in for a
signed-in admin on a developer's machine; the second lets anyone preview the wedding-weekend and
thank-you versions of the homepage before their dates.

The admin is reachable only through a Cloudflare Access application that covers `/admin` and
everything under it (`/admin*`), allowing only the couple. The app checks the signed Access token
on every admin page, download and action itself, so a request that reaches the server some other
way gets nothing.

The database is backed up every night at 02:30 UTC by Dokploy, to a private Cloudflare R2 bucket.
Backups are kept forever.

To deploy automatically, put the Dokploy app's deploy URL in the repository secret `DOKPLOY_DEPLOY_URL`.
Only `main` builds the image and deploys; running the workflow by hand on another branch runs the
tests only. To freeze deploys (the wedding week), blank that secret. To roll back, point the app at an earlier
`:sha-` tag.

## The media worker

Guests' photos and videos are processed by a second process, the media worker (`src/worker/`): its
own image (`Dockerfile.worker`, Debian trixie with ffmpeg and libheif), on its own box
(`nona-worker-01`). It takes the jobs the site queues in Postgres (pg-boss): thumbnails, posters,
conversions, wish recordings, hiding and preview cards, each queue at its own concurrency, so a long
conversion never holds up a photo (conversions run under `nice -n 19` with capped threads). A job
that fails for good marks its item `failed`, with the reason its uploader sees.

- It never migrates the database: it waits ("waiting for schema") until the site has applied every
  migration it was built with, then logs "ready".
- It saves a heartbeat every 30 s. `GET /api/worker-health` on the site answers 200 while the last
  one is under 2 minutes old and 503 otherwise, for the uptime check.
- Every 10 minutes a sweeper queues anything left behind: items uploaded with no job, conversions
  with no job (or, for one a phone asked for or a highlight, no on-demand job), uploads whose
  phone dropped at the very last step (it completes them when R2 holds every part), hidden or
  deleted items whose public files no job has taken down, and videos listed in the last 6 days
  that a playable copy is made for (HEVC, or H.264 every phone plays) whose copy's job was never
  sent for their generation (one that ran, however it ended, is never sent again: pg-boss keeps
  finished jobs 7 days).
- **Hiding** (`media.visibility`): an item the couple hide (or its uploader removes, or the couple
  delete for good) leaves every list at once; then the worker deletes every public file under its
  folder and purges their exact URLs from Cloudflare's cache (`CF_PURGE_TOKEN`, `CF_ZONE_ID`, 30 URLs
  a call), retrying until both are done. What it withdraws is recorded on the row first, so a retry
  purges every one; a permanent delete's original is deleted the same way, once its 30-day lock
  allows. An unhide processes the item again, its files under new keys, and it keeps its place in
  the album.
- **Playable copies** (`media.playable`): once a video's poster is ready, every video whose streams
  an MP4 carries as they are (H.264 or HEVC, with AAC or no sound) gets a clean copy: its own video
  and sound stream-copied (nothing decoded, so in seconds), no metadata but its capture time (so no
  location), `moov` first, its display matrix kept so players turn it, HEVC tagged `hvc1` (as
  Apple's players want, whatever the original's tag). It runs nice'd, under the probe's memory cap
  and five minutes of CPU time (a 2 GB copy takes about 7 CPU-seconds). It is checked before it is
  published (its codec and tag, turn, sound and length, `moov` first, no location in its index) and
  named `derived.playable`. An H.264 video every phone plays (the Android case) plays from this copy;
  its original is never used for playback. A copy that fails never fails the video: it keeps its
  poster, and its conversion goes on where it has one. A browser's VP8/VP9/AV1 or non-AAC sound gets
  no copy: its conversion plays.
- **Conversions** (`media.convert`) make a version of a video every phone plays: H.264 High in MP4,
  within 1920 × 1080 either way up, HDR tone-mapped to SDR, at most 30 fps, CRF 23 with no bitrate
  cap (one can be set: `WORKER_X264_MAXRATE`), AAC stereo, no metadata but its capture time, `moov`
  first. Every video a phone can't play as it is (HEVC, HDR, 4K, slow motion, a browser's WebM) is
  converted; an H.264 video that plays everywhere only when it is over 3 minutes long and over
  about 12 Mbit/s (uncapped CRF 23 makes about 8.7 Mbit/s of a phone's grainy 1080p, so converting
  less would save nothing and cost a generation of quality), otherwise its playable copy is enough. A conversion that starts while no other
  runs gives its decoder and x264 every CPU (`WORKER_CPUS`); one that starts beside another, 2
  each. A phone that can't play an original asks `POST /api/media/[id]/playable`, which sends its
  conversion at priority 20; the worker takes those (and the couple's highlights) at once.
  Everything else waits in the backlog, which runs only while the admin's backlog switch is on: the
  worker reads the switch every 30 s and again before each backlog job, and a job fetched as the
  switch went off goes back to wait, never failed. Each conversion downloads its original to
  scratch (twice its size must be free), runs `nice -n 19` under its own memory cap, a CPU-time
  cap and a time limit, and is checked before it is published: exiting 0 isn't enough. Both limits
  are ten minutes plus so much a second of video, times the frame rate over 30 (60 fps gets twice,
  240 fps slow motion eight times; a file's own rate counts at most 240, however absurd the rate it
  claims): 30 CPU-seconds (a phone's 1080p HDR measured 4.4 to 7.8, so only a file that makes
  ffmpeg work several times harder than any phone's runs out, blamed on its third attempt) and 10
  seconds of time (at most three hours). A conversion that runs past its time is tried again,
  since a busy box can't be told from a slow file by the clock, but its third time-out in a row
  fails it for good, `too-slow`: the video keeps its poster and its playable copy, and the couple
  can retry it from the admin, at priority 20. Only the job that claimed a conversion (its lease)
  carries it on, through its retries; the sweeper puts one whose job is gone back in the queue. A
  video longer than `WORKER_CONVERT_MAX_SECONDS`, or with more frames than 60 a second of it
  (108,000 at the default: half an hour at 60 fps, or 7½ minutes of 240 fps slow motion), isn't
  converted: its conversion is `failed` with the reason `too-long` at once, with no job, and it
  plays from its playable copy where a phone can. Measured under `--cpus=3` at
  the defaults (Task 14b), one conversion alone takes 1.8 to 2.5 s a second of video for 1080 ×
  1920 HEVC HLG with a phone's detail (the first real one, on two threads each: 2.05 s) and 2.2 to
  3.1 s for 4K HEVC HLG, on a shared dev host whose speed varied by a third. The time is CPU, not
  waiting: decoding the HEVC, tone-mapping it (float RGB) and x264 each take about a third. Each
  job logs its own speed and threads.
- On SIGTERM it stops taking jobs, kills ffmpeg and the other tools, and exits within 8 s; the
  interrupted jobs go back to their queues.

To run it locally against docker compose's database and MinIO: `npm run worker` (it builds
`dist/worker` first, with `npm run build:worker`). The site must have migrated the database.

**Deploy.** On every push to `main`, GitHub Actions builds the image and pushes it to
`ghcr.io/thenoblet/nona-worker` (private) as `:latest` and `:sha-<short>`, then calls the repository
secret `DOKPLOY_WORKER_DEPLOY_URL` (skipped when blank: blank it to freeze the worker's deploys).
In Dokploy, the `nona26-worker` app runs that image on `nona-worker-01`, with the same `ghcr.io`
registry login as the site, about 3 CPUs and 12 GB, and the box's scratch folder `/mnt/nona-worker`
bind-mounted at `/scratch`. The image runs as uid:gid `10001:10001`, the scratch folder's owner. It
needs no port.

**Exactly one worker container at a time: 1 replica, deployed stop-first** (Swarm
`update_config.order: stop-first`, never start-first). Dokploy sets this in the app's Swarm
settings, under Update Config, and defaults to start-first, so change it there when creating
`nona26-worker`. Each start removes the scratch folders it
finds (an earlier run's leftovers) and runs its own sweeper, so a second container running beside it,
even for the seconds of a deploy, could remove a running job's files or queue an item twice. The
worker guards against that itself too (Ruling AZ), since Dokploy's form can quietly bring
start-first back: before it removes anything or sweeps, it takes a Postgres session advisory lock
(`pg_try_advisory_lock(1313820225, 1465011026)`, the two-key form, so no single-key lock elsewhere
can be the same) on a connection of its own that stays open, and a second worker logs "waiting
for the previous worker to stop" and tries again every 5 s. The lock goes when the first stops (it
lets it go last, as it exits), dies, or its box vanishes (Postgres notices within about a minute),
and the second then starts within seconds. When a running worker's lock connection drops
(Postgres restarting, a network blip), it takes the lock again on a new connection, ending its own
cut-off session if Postgres still has it, and carries on with its jobs; only if another worker
holds the lock by then does it stop (exit 1), so its restart waits for the lock again. The old container
stops within 8 s of SIGTERM and its interrupted jobs go back to their queues, so stop-first costs
only those seconds. To process more at once, raise the concurrency variables below, never the
replicas.

`pg-boss` is pinned to one exact version in `package.json`: the sweeper reads pg-boss's own `job`
table to see which items have a job, so upgrading pg-boss is a deliberate change, made with
`npm run test:worker`.

Its environment:

| Variable | Default | What it is |
|---|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | | The site's database. |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`, `MEDIA_BASE_URL` | | Cloudflare R2, as the site has them. |
| `WORKER_SCRATCH_DIR` | required | `/scratch`, where the scratch folder is mounted. Without it the worker refuses to start, rather than fill the container's own disk. A folder it can't make, that isn't a folder, or that uid 10001 can't write stops it with one line: "[worker] can't use the scratch folder /scratch: mount /mnt/nona-worker at /scratch, writable by uid 10001". |
| `CF_PURGE_TOKEN` | required | A Cloudflare API token allowed only "Zone · Cache Purge" on the site's zone. When an item is hidden or deleted, the worker deletes its public files and purges their URLs from Cloudflare's cache with it. Without it (or `CF_ZONE_ID`) in production, every hide's job fails and is retried, and the sweeper sends it again, until both are set. |
| `CF_ZONE_ID` | required | The site's Cloudflare zone id, for the purge. |
| `WORKER_PHOTO_CONCURRENCY` | 2 | Photos processed at once. |
| `WORKER_POSTER_CONCURRENCY` | 1 | Videos probed and given a poster at once. |
| `WORKER_WISH_CONCURRENCY` | 1 | Voice and video wishes at once. |
| `WORKER_JPEG_CONCURRENCY` | 1 | Full-size JPEGs of HEIC photos at once. |
| `WORKER_VISIBILITY_CONCURRENCY` | 2 | Hides and unhides at once. |
| `WORKER_CARD_CONCURRENCY` | 1 | Link-preview cards at once. |
| `WORKER_CONVERT_ON_DEMAND_CONCURRENCY` | 1 | Conversions a phone asked for, or highlights, at once. |
| `WORKER_CONVERT_BACKLOG_CONCURRENCY` | 1 | Backlog conversions at once, while the admin's backlog switch is on. |
| `WORKER_PLAYABLE_CONCURRENCY` | 1 | Videos' clean playable copies made at once (a download, a stream copy and an upload each; nothing decoded). |
| `WORKER_CPUS` | 3 | The CPUs the container may use (its limit in Dokploy). A conversion that starts while no other runs gives its decoder and x264 this many threads each. Raise it with the container's CPUs (the backlog week's bigger box): the conversion's memory cap follows it unless `WORKER_CONVERT_MEMORY_BYTES` is set. |
| `WORKER_X264_THREADS` | 2 | x264's threads in a conversion that starts beside another (x264 adds a lookahead thread of its own); a lone one takes `WORKER_CPUS`. |
| `WORKER_X264_MAXRATE` | off | Off by default; set to cap a phone copy's bitrate if mobile data becomes a concern (x264's `-maxrate:v`, e.g. `5M`), together with `WORKER_X264_BUFSIZE`: both or neither. In ffmpeg's notation: bits a second, or with `k` or `M`. Off, a conversion is pure CRF 23: a cap holds the bitrate down in exactly the scenes that need it (dancing, confetti, low light, grain). On, CRF 23 is kept and only its peaks are held to the cap; any T seconds of video then hold at most T × the cap plus the buffer. Changing it gives new conversions keys of their own. |
| `WORKER_X264_BUFSIZE` | off | The cap's buffer (x264's `-bufsize:v`, e.g. `10M`): how far the bitrate may run over the cap for a moment. Off by default; set with `WORKER_X264_MAXRATE`, both or neither. |
| `WORKER_X264_PRESET` | `veryfast` | x264's preset in each conversion, at CRF 23: one of `ultrafast`, `superfast`, `veryfast`, `faster`, `fast`, `medium`, `slow`, `slower`, `veryslow`. A slower one compresses better and takes longer: measure a 4K clip before changing it. |
| `WORKER_CONVERT_MAX_SECONDS` | 1800 | The longest video converted, in seconds, from 60 to 86400, and, times 60, the most frames (its length times its frame rate, counted at most 240). A longer one's, or one with more frames, is `failed` at once with the reason `too-long` (no job, no retries); the video stays in the album with its poster, plays from its playable copy where a phone can, and its original stays downloadable. |
| `WORKER_FFMPEG_DECODER_THREADS` | 2 | ffmpeg's decoder threads in a conversion that starts beside another (its `-threads` before the input), which would otherwise be the host's CPUs; a lone one takes `WORKER_CPUS`. Two decode 4K HEVC in about real time. |
| `WORKER_SHARP_THREADS` | 1 | sharp's threads in each photo. |
| `WORKER_FFMPEG_FILTER_THREADS` | 1 | ffmpeg's filter threads (scaling, tone-mapping) in each job, a lone conversion's too. Measured under `--cpus=3`, more made a conversion slower, not faster, since x264 and the decoder already keep the CPUs busy: for 20 s of 1080 × 1920 HLG on 3 decoder and x264 threads, 1.56 s a second of video at 1, 2.00 at 2 and 2.15 at 3 (Task 14b); earlier, 2 made a 4K HDR conversion 18.4 s against 12 to 17 s. |
| `WORKER_HEIF_THREADS` | 1 | `heif-dec`'s codec and tile threads for each HEIC (libheif would otherwise decode 4 tiles at once). |
| `WORKER_HEIF_MEMORY_BYTES` | 2147483648 (2 GiB) | The most memory (address space) `heif-info` and `heif-dec` may take for one HEIC, at least 256 MiB: a backstop against a crafted file. A 48 MP iPhone photo decodes in about 300 MB; a file that hits the cap fails as `corrupt`. |
| `WORKER_POSTER_THREADS` | 1 | ffmpeg's `-threads` for each video's poster: decoding its frame and writing it. Each thread takes its own stack and heap within `WORKER_FFMPEG_MEMORY_BYTES`: measure the cap again before raising this or `WORKER_FFMPEG_FILTER_THREADS`. |
| `WORKER_FFMPEG_MEMORY_BYTES` | 2147483648 (2 GiB) | The most memory (address space) `ffprobe` and `ffmpeg` may take for one video's probe and poster, at least 1 GiB: a backstop against a crafted file. Measured on one thread each (`WORKER_POSTER_THREADS` and `WORKER_FFMPEG_FILTER_THREADS` at 1), a 4K HDR poster needs about 830 MiB and an 8K one about 980 MiB. A file that runs out of memory under the cap three times fails as `corrupt`; a thread ffmpeg can't start (`pthread_create`, "Resource temporarily unavailable") is the worker's trouble and retries. |
| `WORKER_CONVERT_MEMORY_BYTES` | 3 GiB, more for a higher `WORKER_CPUS` | The most memory (address space) a conversion's `ffmpeg` may take, at least 2 GiB: a backstop against a crafted file. Its need grows with its threads (each takes a stack and a heap of its own, mostly reserved). Measured in the worker image, a lone portrait 4K HEVC HLG conversion peaks at 1,873 MiB on 3 decoder and x264 threads (RSS about 790 MiB), 2,614 MiB on 8 and 3,834 MiB on 16; 8K HEVC on 3, 1,753 MiB; two each (two conversions at once), 1,727 MiB. Each filter thread past the first adds about 85 MiB (1080p HLG on 3 each: 1,562 MiB with one, 1,730 with three). Unset, it is 3 GiB, or 1.6 times about 1,450 MiB plus 150 MiB a thread and 85 MiB a filter thread past the first, where that is more (`WORKER_CPUS=16`: 6,400 MiB). Set below that need, the worker refuses to start, rather than fail every conversion as the file's fault. As for posters, running out of memory under the cap three times fails the conversion, and the video keeps its poster. |
| `WORKER_QUEUE_POOL_SIZE` | 10 | Database connections for the job queue. |

The defaults suit about 3 CPUs and 12 GB. Thread counts never follow the machine's core count,
which inside Docker is the host's, not the container's share; for a bigger box (the backlog week),
raise the container's CPUs and these numbers together.
