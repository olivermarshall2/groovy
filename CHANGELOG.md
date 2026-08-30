# Changelog

All notable project changes should be recorded here. Keep the newest entry at the top.

## 0.25.0 - 2026-08-30

### Changed

- Fixed the web artwork loading placeholders so the new shared cover frame inherits the correct size and aspect rules across Books, Library, Artists, playlists, track rows, and detail heroes instead of only showing reliably on the Home page.
- Added shared artwork loading placeholders across the web app so hero art and entity cards show a shaped shimmering stand-in while cover images load instead of appearing blank.
- Reduced web navigation lag between `Books` and `Library` by deferring view-specific group building, limiting large library recomputations to the active screen, and progressively rendering large card grids in batches.
- Improved the web debug log so routine bootstrap polling no longer floods the log unless the bootstrap state changes or a poll is unusually slow, and added route render timing entries for page-to-page UI performance diagnosis.
- Split the web app startup path into a faster staged load: bootstrap first, then lightweight library lists, then deferred track-heavy playlists and history data in the background or when track-centric views are opened.
- Fixed the Settings log viewer so the `Copy log` action works on non-secure LAN origins with a clipboard fallback, and the plain-text log pane can be selected directly for manual copy.
- Stopped the scheduled mobile cover-art job from auto-running after Docker restarts or updates when the server starts after the scheduled time, while keeping manual `Run Now` support intact.
- Added a stronger Android last-good-library snapshot for books and tracks so non-offline books remain visible from cache when a refresh fully fails during temporary server/network outages.
- Reused the cached track snapshot when opening book detail, allowing non-offline books to open from cached chapters even if the live track refresh is unavailable.
- Kept the cached library snapshot in sync during playlist and like updates so later lightweight writes do not accidentally discard cached book visibility after a failed refresh.

## 0.24.0 - 2026-08-30

### Changed

- Virtualized the Android Books browser so large audiobook libraries scroll more smoothly like the Albums and Artists pages.
- Preserved cached audiobook progress badges in derived and offline book collections so `In Progress` and `Complete` status stays visible on Books and author collection cards after app or server restarts.
- Added consistent Android sync status icons for books across list cards, author collection cards, and the book detail hero image, including visible downloading and queued states.
- Sped up Android pull-to-refresh when nothing changed on the server by skipping the expensive offline cover-art refresh when the server scan timestamp is unchanged.

## 0.23.0 - 2026-08-30

### Changed

- Preserved Android audiobook progress and completed status when books are rebuilt from cached tracks or synced offline bundles instead of the server books endpoint.
- Added a cached-book-detail fallback so opening a book continues to work from local track data when the server briefly returns `Book not found` after a restart or Docker update.
- Limited expensive offline cover-art refresh work to explicit pull-to-refresh actions so Android startup and routine background refreshes stay faster on the local network.

## 0.22.0 - 2026-08-30

### Changed

- Restyled the web Settings page so its section tabs match the left navigation language, the save action sits in the header, build info is shown without boxed tiles, and logs render in a plain scrollable text pane.
- Reduced zero-change scheduled music rescans by only refreshing album artwork and metadata sidecars for folders with changed tracks, deleted tracks, or missing sidecar/artwork files.
- Added a Logs tab to the web Settings page with browser-side debug diagnostics for startup, route changes, bootstrap timing, library endpoint timings, and environment details useful for investigating slow application loads.
- Moved library settings into a full Settings page route in the web app while keeping the existing button entry point and left navigation layout.
- Improved web app responsiveness by optimizing album, artist, and book grouping logic, memoizing heavy derived library views, and deferring search filtering work.
- Added proper ESM JSON import attributes to the server build-info manifest imports so the Docker runtime can start cleanly on Node 22.
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
