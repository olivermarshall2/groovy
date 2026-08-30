# Changelog

All notable project changes should be recorded here. Keep the newest entry at the top.

## 0.22.0 - 2026-08-30

### Changed

- Fixed the Docker runtime image so the web package manifest is present for the settings build-info endpoint, preventing the production container from crash-looping with `ERR_MODULE_NOT_FOUND`.
- Added a server-side fallback that derives books from tracked audiobook chapters when the primary books query returns empty, restoring Android book lists, book detail loading, and book offline sync after the mobile-cover-art update.
- Reworked the web settings dialog into left-side `General`, `Folders`, and `Jobs` tabs with a slightly smaller settings font and a new build-information panel.
- Added scheduled mobile cover-art job status reporting plus a `Run Now` action with live progress feedback in the web settings UI.
- Expanded scan progress feedback so the long finalization phase now reports specific sub-steps, sidecar write counts, and recent heartbeat timing.
- Renamed audiobook state sidecars from `.mp3-platform-book-state.json` to `.groovy-book-state.json` while preserving one-scan legacy migration support.
- Optimized rescans of already indexed folders by preloading existing folder tracks, limiting folder prune queries, and restricting book sidecar restore/write work to affected books only.

## 0.21.0 - 2026-08-30

### Changed

- Hardened large network folder scans by avoiding a separate pre-count pass and reporting scan phase/file progress as files are discovered.
- Added scanner timeouts and error handling around slow directory, file stat, metadata, and cover-art reads so problematic network entries do not stall the whole scan.
- Improved scan progress accounting by counting audio files per discovered folder before metadata reads begin.
- Updated audiobook metadata handling so book authors are derived from the Artist tag while Album Artist remains available for narrator-oriented client display.
- Added nightly mobile cover-art optimization for Android-friendly remote and offline artwork.
- Improved Android library refresh behavior so suspicious empty responses from large-folder syncs do not wipe the cached library.
- Added Android fallbacks that derive audiobook collections from track data when the books endpoint is temporarily empty.

## 0.17.0 - 2026-08-29

### Added

- Added Docker production packaging with a Node 22 runtime and `ffmpeg` for metadata editing.
- Added an example Docker Compose deployment with persistent SQLite data and NAS media mounts.
- Added GitHub Actions workflow for publishing Docker images to GitHub Container Registry.
- Added Docker deployment documentation covering Ubuntu, NAS mounts, updates, and backups.
- Added a private LAN/VPN-only Nginx proxy config for the Ubuntu host.
- Updated example deployment files for the `ghcr.io/olivermarshall2/groovy` image path.

### Changed

- Expanded repository ignores to keep local logs, secrets, dependency caches, build metadata, and test binaries out of Git.
- Set Docker builds to CI mode so pnpm can prune production dependencies in non-interactive builds.
- Kept the Docker deployment private by exposing Groovy only to Nginx on Docker's internal network instead of publishing the app port on the host.
- Added configurable default media roots and Docker bind mounts for host-mounted NAS music and audiobook shares.
- Separated public Docker examples from instance-specific database, NAS mount, and credential values.
