# MP3 Platform

MP3 Platform is a self-hosted music and audiobook server for local media libraries. It provides a Fastify API, a React web app, SQLite-backed library indexing, OpenSubsonic-compatible endpoints, and an Android client for offline album and book sync.

## Highlights

- 🎧 Stream MP3, FLAC, and M4B files from your own library.
- 📚 Treat audiobooks as Books, with resume position and bookmarks.
- 🗂️ Index albums, artists, tracks, playlists, recently played items, likes, and cover art.
- 🔎 Scan configured music and book folders on startup, on schedule, or on demand.
- 🛠️ Edit selected tags and write album sidecars/artwork when the media mount is writable.
- 📱 Sync albums, books, and playlists to the Android app for offline playback.
- 🌐 Serve the built web UI and API from one Fastify server.
- 🐳 Run as a Docker container on Linux with persistent SQLite storage.

## Workspace Layout

| Path | Purpose |
|---|---|
| `apps/server` | Fastify API, scanner, metadata ingestion, streaming, SQLite storage |
| `apps/web` | React + Vite browser app |
| `apps/android` | Expo/React Native Android client |
| `packages/shared` | Shared TypeScript types |
| `packages/expo-audio` | Local Expo audio package used by the Android app |
| `docs/docker-deployment.md` | Docker, Ubuntu, NAS mount, update, and backup guide |

## Stack

- Frontend: React, Vite, TypeScript, Tailwind CSS
- API: Fastify, TypeScript
- Database: SQLite through Node's built-in `node:sqlite`
- Metadata: `music-metadata`
- File watching/scanning: `chokidar`
- Tag editing: `ffmpeg`
- Package manager: pnpm

## Local Development

Install dependencies:

```bash
pnpm install
```

Run the server and web dev app:

```bash
pnpm dev
```

Build everything:

```bash
pnpm build
```

Run the production-style local server:

```bash
pnpm serve
```

The built web app is served by the Fastify server at:

```text
http://127.0.0.1:4318
```

On first visit, create the initial user and configure your music/book library roots.

## Configuration

Runtime configuration is environment-driven. See `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address for the server |
| `PORT` | `4318` | Web/API port |
| `DATABASE_PATH` | `apps/server/data/library.db` | SQLite file path |
| `SCAN_INTERVAL_MINUTES` | `15` | Scheduled scanner interval |
| `MUSIC_LIBRARY_ROOTS` | empty | Comma-separated default music roots for first-run setup, for example `/music` |
| `AUDIOBOOK_LIBRARY_ROOTS` | empty | Comma-separated default audiobook roots for first-run setup, for example `/audiobooks` |
| `SUBSONIC_USERNAME` | `symfonium` | OpenSubsonic compatibility username |
| `SUBSONIC_PASSWORD` | `change-me` | Change before real use |
| `SUBSONIC_API_KEY` | `change-me` | Change before real use |
| `DISCOGS_*` | empty | Optional metadata lookup credentials |

## Docker

The app can run as a single Docker container. The server serves both the API and the built React app.

Build locally:

```bash
docker build -t mp3-platform .
```

Run locally with bind mounts:

```bash
docker run --rm \
  -p 4318:4318 \
  -e MUSIC_LIBRARY_ROOTS=/music \
  -e AUDIOBOOK_LIBRARY_ROOTS=/audiobooks \
  -e DATABASE_PATH=/data/library.db \
  -v mp3-platform-data:/data \
  -v /path/to/Music:/music \
  -v /path/to/Audiobooks:/audiobooks \
  mp3-platform
```

For a private server deployment, prefer Docker Compose with `expose` and an internal Nginx proxy rather than publishing `4318` directly on the host.

When running in Docker, configure the app with container paths such as:

```text
/music
/audiobooks
```

For Ubuntu and NAS deployment details, read [Docker Deployment](docs/docker-deployment.md).

The repo also includes a private Nginx server block at `deploy/nginx/groovy-local.conf` for LAN/VPN-only access on the current Ubuntu host.

## NAS And UNC Paths

For Linux/Docker deployments, mount SMB/UNC shares on the Ubuntu host and expose them to the container as normal Linux paths.

Example:

```text
//NAS/Public/Music -> /mnt/nas/music on the Linux host -> /music inside Docker
//NAS/Public/Audiobooks -> /mnt/nas/audiobooks on the Linux host -> /audiobooks inside Docker
```

This keeps NAS credentials and reconnect behavior at the host layer, where Linux and systemd can manage them cleanly.

## GitHub Container Registry

The repository includes a GitHub Actions workflow at `.github/workflows/docker-image.yml`.

On pushes to `main` or `master`, it builds and publishes a Docker image to:

```text
ghcr.io/olivermarshall2/groovy
```

Deployment hosts can update with:

```bash
docker compose pull
docker compose up -d
```

## Android App

Start the local media server first:

```bash
pnpm start
```

Then run the Android app:

```bash
pnpm dev:android
```

In the app, enter your server URL, for example:

```text
http://192.168.1.10:4318
```

## OpenSubsonic Compatibility

The server exposes a basic OpenSubsonic-compatible surface under `/rest/*.view`, including:

- `ping`
- `getLicense`
- `getOpenSubsonicExtensions`
- `getTokenInfo`
- `getMusicFolders`
- `getIndexes`
- `getArtists`
- `getArtist`
- `getAlbum`
- `getAlbumList2`
- `getGenres`
- `getCoverArt`
- `getSong`
- `download`
- `search3`
- `stream`

Authentication supports `u`/`p` query parameters and `apiKey`.

## Maintenance

Keep these files current when behavior changes:

- `README.md` for setup, deployment, and operating instructions.
- `CHANGELOG.md` for notable user-facing or deployment changes.
- `docs/docker-deployment.md` for Docker, Ubuntu, NAS, backup, and update workflow changes.

Before publishing a release or Docker image:

```bash
pnpm build
pnpm typecheck
```
