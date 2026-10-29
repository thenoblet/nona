# NONA'26

The wedding website for Noblet & Nancy: the invitation, RSVP, a shared photo and video
album guests use from their phones (no app, no sign-up), a guestbook, and screens for the venue.

Mobile-first: every page is designed for a phone, then widened for larger screens.

## Pages

| Route | What it is |
|---|---|
| `/` | Landing page (editorial cover). "Open the invitation" starts the music and opens `/home`. |
| `/home` | The homepage. The date picks one of three versions: **before** (the invitation), **wedding weekend** (5 and 6 Dec: photo sharing, today's schedule, seat finder) and **after** (thank you, full album, wishes). |
| `/rsvp` | Reply form. |
| `/album` | The shared album the table QR codes open. |
| `/wishes` | Guestbook: written, voice or video wishes. |
| `/today` | Wedding-day screen: what's happening now, seat finder, quick actions. |
| `/open` | Envelope opener, an optional phone entry with a wax seal. |
| `/slideshow` | Venue TV screen showing guests' newest photos, with a QR code. |
| `/print/table-card?table=7` | Printable A5 QR card for each table. |

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
    data/              rsvp.ts, media.ts, wishes.ts: stand-in data (see below)
    qr.ts              album QR codes
  fonts/               self-hosted fonts (no request to Google)
public/
  images/              story photos and flowers
  audio/               the three songs, .webm + .mp3 (mp3 for older iPhones)
```

**To change wording, dates, places or the wedding party, edit `src/content/wedding.ts`.**
Anything still to confirm is in square brackets, like `[Nancy's church]` and `[Start time]`.

## Stand-in data (to replace)

Everything in `src/lib/data/` is a stub with the final function signatures, so the pages
won't change when the real backend arrives:

- `rsvp.ts`: replies are kept in memory and lost on restart. Next: Postgres, plus SMS confirmations.
- `media.ts`: a fixed set of sample photos. Next: Postgres rows pointing at S3 objects served through CloudFront.
- `wishes.ts`: sample wishes plus any sent while the server runs. Next: Postgres, voice and video in S3.

Search for `TODO` to find the other placeholders: uploads (S3 presigned multipart), downloads
(per-celebration zips), voice and video recording, calendar files, the seat lookup, the
device cookie for "My uploads", and live updates for the album and slideshow (Server-Sent Events).

When guest media moves to CloudFront, add its host to `images.remotePatterns` in `next.config.ts`.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run build
```

Built with Next.js 16 (App Router, Cache Components), React 19, TypeScript and Tailwind CSS 4.
Colours and shadows are Tailwind tokens in `src/app/globals.css` (`cocoa`, `mocha`, `ember`,
`blush`, `tray`, `halo`, `hairline`, ...).

## Deploy (Dokploy)

The `Dockerfile` builds a standalone Next.js server. In Dokploy, create an application from this
repository with the Dockerfile build type, expose port `3000`, and set:

- `SITE_URL`: the public address, e.g. `https://nona26.com` (used in QR codes)
