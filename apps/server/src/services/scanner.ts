import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ScanStatus, TrackRecord } from "@mp3-platform/shared";
import type { LibraryRepository } from "../storage/library-repository.js";
import { normalizeMediaPath } from "../storage/ids.js";
import { persistBookStateSidecar, restoreBookStateSidecars } from "./book-state-sidecar.js";
import { getFolderCoverArtModifiedAt, readAudioMetadata, readFolderCoverArt } from "./tag-reader.js";
import { syncLibraryArtifacts, type ScannedTrackArtifact } from "./library-artifacts.js";

type ScanReason = "startup" | "scheduled" | "manual";

type ScannerDependencies = {
  defaultScanIntervalMinutes: number;
  repository: LibraryRepository;
  discogsAuth: { userToken: string | null; consumerKey: string | null; consumerSecret: string | null } | null;
};

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4b"]);
const MAX_RECENT_ERRORS = 20;

const uniqueRoots = (roots: string[]) => [...new Set(roots.map((root) => root.trim()).filter(Boolean))];

const isPathInsideRoot = (filePath: string, rootPath: string) => {
  const normalizedFilePath = normalizeMediaPath(filePath).replace(/\/+$/, "");
  const normalizedRoot = normalizeMediaPath(rootPath).replace(/\/+$/, "");

  return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}/`);
};

const toArtifactTrack = (track: TrackRecord): ScannedTrackArtifact => ({
  filePath: track.filePath,
  title: track.title,
  artist: track.artist,
  album: track.album,
  albumArtist: track.albumArtist,
  genre: track.genre,
  year: track.year,
  discNumber: track.discNumber,
  trackNumber: track.trackNumber,
  durationSeconds: track.durationSeconds,
  musicBrainzReleaseId: null,
  musicBrainzArtistId: null,
  musicBrainzAlbumArtistId: null
});

const getEffectiveModifiedAt = (fileModifiedAt: string, coverArtModifiedAt: string | null) => {
  if (!coverArtModifiedAt) {
    return fileModifiedAt;
  }

  return coverArtModifiedAt > fileModifiedAt ? coverArtModifiedAt : fileModifiedAt;
};

const areByteArraysEqual = (left: Uint8Array | null | undefined, right: Uint8Array | null | undefined) => {
  if (!left || !right) {
    return !left && !right;
  }

  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
};

export const createScanner = ({ defaultScanIntervalMinutes, repository, discogsAuth }: ScannerDependencies) => {
  let timer: NodeJS.Timeout | undefined;
  let activeScan: Promise<void> | null = null;
  let queuedReason: ScanReason | null = null;
  const seenPaths = new Set<string>();
  const status: ScanStatus = {
    isScanning: false,
    currentReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    processedFiles: 0,
    totalFiles: 0,
    progressPercent: 0,
    queued: false,
    recentErrors: []
  };

  const pushError = (filePath: string, message: string) => {
    status.recentErrors = [
      {
        filePath,
        message,
        at: new Date().toISOString()
      },
      ...status.recentErrors
    ].slice(0, MAX_RECENT_ERRORS);
  };

  const updateProgress = () => {
    status.progressPercent =
      status.totalFiles > 0
        ? Math.min(100, Math.round((status.processedFiles / status.totalFiles) * 100))
        : 0;
  };

  const countAudioFiles = async (root: string): Promise<number> => {
    const entries = await readdir(root, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);

      if (entry.isDirectory()) {
        count += await countAudioFiles(fullPath);
        continue;
      }

      if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        count += 1;
      }
    }

    return count;
  };

  const scanFolder = async (
    root: string,
    libraryRoot: string,
    collectedTracks: ScannedTrackArtifact[],
    seenPathsSet?: Set<string>
  ) => {
    const folderCoverArtCache = new Map<string, Awaited<ReturnType<typeof readFolderCoverArt>>>();
    const entries = await readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);

      if (entry.isDirectory()) {
        await scanFolder(fullPath, libraryRoot, collectedTracks, seenPathsSet);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!AUDIO_EXTENSIONS.has(extension)) {
        continue;
      }

      const fileStats = await stat(fullPath);
      const normalizedPath = normalizeMediaPath(fullPath);

      if (seenPathsSet) {
        seenPathsSet.add(normalizedPath);
      }

      seenPaths.add(normalizedPath);

      let metadata;
      const appSettings = repository.getAppSettings();
      const forcedBook = appSettings.bookRoots.some((bookRoot) => isPathInsideRoot(fullPath, bookRoot));
      const existingTrack = repository.getTrackByFilePath(fullPath);
      const fileModifiedAt = fileStats.mtime.toISOString();
      const coverArtModifiedAt = await getFolderCoverArtModifiedAt(fullPath, libraryRoot);
      const effectiveModifiedAt = getEffectiveModifiedAt(fileModifiedAt, coverArtModifiedAt);
      const cachedFolderCoverArt = folderCoverArtCache.get(fullPath);
      const currentFolderCoverArt = cachedFolderCoverArt === undefined ? await readFolderCoverArt(fullPath, libraryRoot) : cachedFolderCoverArt;
      if (cachedFolderCoverArt === undefined) {
        folderCoverArtCache.set(fullPath, currentFolderCoverArt);
      }
      let preloadedMetadata: Awaited<ReturnType<typeof readAudioMetadata>> | null = null;

      if (forcedBook && extension === ".m4b") {
        try {
          preloadedMetadata = await readAudioMetadata(fullPath, libraryRoot);
        } catch {
          preloadedMetadata = null;
        }
      }

      const storedCoverArt =
        forcedBook && existingTrack?.coverArtId
          ? repository.getCoverArtById(existingTrack.coverArtId)
          : null;
      const prefersEmbeddedBookCover = forcedBook && extension === ".m4b" && preloadedMetadata?.coverArtSource === "embedded";
      const bookFolderCoverChanged =
        forcedBook &&
        !!existingTrack &&
        !prefersEmbeddedBookCover &&
        (
          (currentFolderCoverArt?.mimeType ?? null) !== (storedCoverArt?.mimeType ?? null) ||
          !areByteArraysEqual(currentFolderCoverArt?.data ?? null, storedCoverArt?.data ?? null)
        );
      const unchangedTrack =
        existingTrack &&
        existingTrack.modifiedAt === effectiveModifiedAt &&
        existingTrack.sizeBytes === fileStats.size &&
        (forcedBook ? existingTrack.mediaKind === "book" : existingTrack.mediaKind === "music") &&
        !bookFolderCoverChanged;

      if (unchangedTrack) {
        collectedTracks.push(toArtifactTrack(existingTrack));
        status.processedFiles += 1;
        updateProgress();
        continue;
      }

      if (preloadedMetadata) {
        metadata = preloadedMetadata;
      } else {
        try {
          metadata = await readAudioMetadata(fullPath, libraryRoot);
        } catch (error) {
          metadata = {
            title: null,
            mediaKind: "music" as const,
            bookId: null,
            bookTitle: null,
            author: null,
            artist: null,
            album: null,
            albumArtist: null,
            genre: null,
            year: null,
            discNumber: null,
            trackNumber: null,
            durationSeconds: null,
            bitrate: null,
            sampleRate: null,
            coverArtMime: null,
            coverArtData: null,
            coverArtSource: null,
            musicBrainzReleaseId: null,
            musicBrainzArtistId: null,
            musicBrainzAlbumArtistId: null
          };
          pushError(fullPath, error instanceof Error ? error.message : "Failed to read metadata");
        }
      }

      if (forcedBook) {
        const useEmbeddedM4bCover = extension === ".m4b" && metadata.coverArtSource === "embedded";
        metadata = {
          ...metadata,
          mediaKind: "book" as const,
          bookTitle: metadata.bookTitle ?? metadata.album ?? path.basename(path.dirname(fullPath)),
          coverArtMime: useEmbeddedM4bCover ? metadata.coverArtMime : currentFolderCoverArt?.mimeType ?? metadata.coverArtMime,
          coverArtData: useEmbeddedM4bCover ? metadata.coverArtData : currentFolderCoverArt?.data ?? metadata.coverArtData
        };
      }

      const { coverArtSource: _coverArtSource, ...persistedMetadata } = metadata;

      repository.upsertTrack({
        filePath: fullPath,
        format: extension.slice(1),
        modifiedAt: effectiveModifiedAt,
        sizeBytes: fileStats.size,
        ...persistedMetadata
      });
      collectedTracks.push({
        filePath: fullPath,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        albumArtist: metadata.albumArtist,
        genre: metadata.genre,
        year: metadata.year,
        discNumber: metadata.discNumber,
        trackNumber: metadata.trackNumber,
        durationSeconds: metadata.durationSeconds,
        musicBrainzReleaseId: metadata.musicBrainzReleaseId,
        musicBrainzArtistId: metadata.musicBrainzArtistId,
        musicBrainzAlbumArtistId: metadata.musicBrainzAlbumArtistId
      });
      status.processedFiles += 1;
      updateProgress();
    }
  };

  const runScan = async (reason: ScanReason) => {
    status.isScanning = true;
    status.currentReason = reason;
    status.lastStartedAt = new Date().toISOString();
    status.processedFiles = 0;
    status.totalFiles = 0;
    status.progressPercent = 0;
    seenPaths.clear();
    const settings = repository.getAppSettings();

    try {
      const scanRoots = uniqueRoots([...settings.libraryRoots, ...settings.bookRoots]);

      for (const root of scanRoots) {
        try {
          await access(root);
          status.totalFiles += await countAudioFiles(root);
        } catch {
          continue;
        }
      }

      for (const root of scanRoots) {
        try {
          await access(root);
        } catch {
          continue;
        }

        const collectedTracks: ScannedTrackArtifact[] = [];
        await scanFolder(root, root, collectedTracks, seenPaths);
        const isBookRoot = settings.bookRoots.some((bookRoot) => normalizeMediaPath(bookRoot) === normalizeMediaPath(root));

        if (!isBookRoot) {
          await syncLibraryArtifacts({
            root,
            tracks: collectedTracks,
            pushError,
            discogsAuth
          });
        }
      }

      repository.pruneMissingTracks(scanRoots, seenPaths);
      await restoreBookStateSidecars(repository);
      for (const bookId of repository.listTrackedBookIds()) {
        await persistBookStateSidecar(repository, bookId);
      }
      repository.recordScan({
        completedAt: new Date().toISOString(),
        reason
      });
    } finally {
      status.isScanning = false;
      status.currentReason = null;
      status.lastCompletedAt = new Date().toISOString();
      status.progressPercent = status.totalFiles > 0 ? 100 : 0;
      activeScan = null;
      status.queued = queuedReason !== null;

      if (queuedReason) {
        const nextReason = queuedReason;
        queuedReason = null;
        status.queued = false;
        startScan(nextReason);
      }
    }
  };

  const runFolderScan = async (folderPath: string, reason: ScanReason) => {
    if (activeScan) {
      await activeScan;
    }

    status.isScanning = true;
    status.currentReason = reason;
    status.lastStartedAt = new Date().toISOString();
    status.processedFiles = 0;
    status.totalFiles = 0;
    status.progressPercent = 0;

    const seenFolderPaths = new Set<string>();

    try {
      try {
        await access(folderPath);
        status.totalFiles = await countAudioFiles(folderPath);
      } catch {
        return;
      }

      const collectedTracks: ScannedTrackArtifact[] = [];
      const settings = repository.getAppSettings();
      await scanFolder(folderPath, folderPath, collectedTracks, seenFolderPaths);
      const isBookFolderScan = settings.bookRoots.some((bookRoot) => normalizeMediaPath(bookRoot) === normalizeMediaPath(folderPath));

      if (!isBookFolderScan) {
        await syncLibraryArtifacts({
          root: folderPath,
          tracks: collectedTracks,
          pushError,
          discogsAuth
        });
      }
      repository.pruneMissingTracksInFolder(folderPath, seenFolderPaths);
      await restoreBookStateSidecars(repository);
      for (const bookId of repository.listTrackedBookIds()) {
        await persistBookStateSidecar(repository, bookId);
      }
      repository.recordScan({
        completedAt: new Date().toISOString(),
        reason
      });
    } finally {
      status.isScanning = false;
      status.currentReason = null;
      status.lastCompletedAt = new Date().toISOString();
      status.progressPercent = status.totalFiles > 0 ? 100 : 0;
    }
  };

  const startScan = (reason: ScanReason) => {
    if (activeScan) {
      return false;
    }

    activeScan = runScan(reason);
    void activeScan;
    return true;
  };

  const requestScan = (reason: ScanReason) => {
    if (activeScan) {
      queuedReason = reason;
      status.queued = true;
      return "queued" as const;
    }

    startScan(reason);
    return "started" as const;
  };

  const runOnce = async (reason: ScanReason) => {
    if (activeScan) {
      await activeScan;
    }

    activeScan = runScan(reason);
    await activeScan;
  };

  const schedule = () => {
    const settings = repository.getAppSettings();
    const intervalMinutes = settings.scanIntervalMinutes || defaultScanIntervalMinutes;
    const intervalMs = intervalMinutes * 60_000;
    timer = setInterval(() => {
      startScan("scheduled");
    }, intervalMs);
  };

  const resetSchedule = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    schedule();
  };

  return {
    async start() {
      const summary = repository.getLibrarySummary();

      if (summary.trackCount === 0 || !summary.lastScanAt) {
        void runOnce("startup");
      }

      schedule();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
      }
    },
    getStatus() {
      return {
        ...status
      };
    },
    requestScan,
    runFolderScan,
    resetSchedule,
    startScan,
    runOnce
  };
};
