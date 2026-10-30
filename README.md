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
