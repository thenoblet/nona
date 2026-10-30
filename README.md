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
  with no job, and uploads whose phone dropped at the very last step (it completes them when R2
  holds every part).
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
old container stops within 8 s of SIGTERM and its interrupted jobs go back to their queues, so
stop-first costs only those seconds. To process more at once, raise the concurrency variables
below, never the replicas.

`pg-boss` is pinned to one exact version in `package.json`: the sweeper reads pg-boss's own `job`
table to see which items have a job, so upgrading pg-boss is a deliberate change, made with
`npm run test:worker`.

Its environment:

| Variable | Default | What it is |
|---|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | | The site's database. |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`, `MEDIA_BASE_URL` | | Cloudflare R2, as the site has them. |
| `WORKER_SCRATCH_DIR` | required | `/scratch`, where the scratch folder is mounted. Without it the worker refuses to start, rather than fill the container's own disk. |
| `WORKER_PHOTO_CONCURRENCY` | 2 | Photos processed at once. |
| `WORKER_POSTER_CONCURRENCY` | 1 | Videos probed and given a poster at once. |
| `WORKER_WISH_CONCURRENCY` | 1 | Voice and video wishes at once. |
| `WORKER_JPEG_CONCURRENCY` | 1 | Full-size JPEGs of HEIC photos at once. |
| `WORKER_VISIBILITY_CONCURRENCY` | 2 | Hides and unhides at once. |
| `WORKER_CARD_CONCURRENCY` | 1 | Link-preview cards at once. |
| `WORKER_CONVERT_ON_DEMAND_CONCURRENCY` | 1 | Conversions a phone asked for, or highlights, at once. |
| `WORKER_CONVERT_BACKLOG_CONCURRENCY` | 1 | Backlog conversions at once, while the admin's backlog switch is on. |
| `WORKER_X264_THREADS` | 2 | x264's threads in each conversion. |
| `WORKER_SHARP_THREADS` | 1 | sharp's threads in each photo. |
| `WORKER_FFMPEG_FILTER_THREADS` | 1 | ffmpeg's filter threads (scaling, tone-mapping) in each job. |
| `WORKER_QUEUE_POOL_SIZE` | 10 | Database connections for the job queue. |

The defaults suit about 3 CPUs and 12 GB. Thread counts never follow the machine's core count,
which inside Docker is the host's, not the container's share; for a bigger box (the backlog week),
raise the container's CPUs and these numbers together.
