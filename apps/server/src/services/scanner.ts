import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ScanStatus, TrackRecord } from "@mp3-platform/shared";
import type { LibraryRepository } from "../storage/library-repository.js";
import { normalizeMediaPath } from "../storage/ids.js";
import { persistBookStateSidecar, restoreBookStateSidecars } from "./book-state-sidecar.js";
import { getFolderCoverArtModifiedAt, getTrackCoverArtModifiedAt, readAudioMetadata, readFolderCoverArt } from "./tag-reader.js";
import { syncLibraryArtifacts, type ScannedTrackArtifact } from "./library-artifacts.js";
import { cronMatches, getCronMinuteKey } from "./cron-schedule.js";

type ScanReason = "startup" | "scheduled" | "manual";

type ScannerDependencies = {
  repository: LibraryRepository;
  discogsAuth: { userToken: string | null; consumerKey: string | null; consumerSecret: string | null } | null;
};

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4b"]);
const ARTWORK_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const MAX_RECENT_ERRORS = 20;
const FILE_OPERATION_TIMEOUT_MS = 20_000;
const REQUIRED_MUSIC_SIDECAR_NAMES = ["album.nfo", "artist.nfo"];

const uniqueRoots = (roots: string[]) => [...new Set(roots.map((root) => root.trim()).filter(Boolean))];

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

const getEffectiveModifiedAt = (fileModifiedAt: string, ...artworkModifiedAts: Array<string | null>) => {
  let effectiveModifiedAt = fileModifiedAt;

  for (const artworkModifiedAt of artworkModifiedAts) {
    if (artworkModifiedAt && artworkModifiedAt > effectiveModifiedAt) {
      effectiveModifiedAt = artworkModifiedAt;
    }
  }

  return effectiveModifiedAt;
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

export const createScanner = ({ repository, discogsAuth }: ScannerDependencies) => {
  let timer: NodeJS.Timeout | undefined;
  let activeScan: Promise<void> | null = null;
  let queuedReason: ScanReason | null = null;
  let lastScheduledMinute: string | null = null;
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
    currentFilePath: null,
    currentPhase: null,
    currentStepLabel: null,
    phaseProcessedItems: 0,
    phaseTotalItems: 0,
    lastProgressAt: null,
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

  const markProgress = () => {
    status.lastProgressAt = new Date().toISOString();
  };

  const updateProgress = () => {
    status.progressPercent =
      status.totalFiles > 0
        ? Math.min(100, Math.round((status.processedFiles / status.totalFiles) * 100))
        : 0;
    markProgress();
  };

  const setPhase = (
    phase: ScanStatus["currentPhase"],
    currentFilePath: string | null,
    currentStepLabel: string | null,
    phaseProcessedItems = 0,
    phaseTotalItems = 0
  ) => {
    status.currentPhase = phase;
    status.currentFilePath = currentFilePath;
    status.currentStepLabel = currentStepLabel;
    status.phaseProcessedItems = phaseProcessedItems;
    status.phaseTotalItems = phaseTotalItems;
    markProgress();
  };

  const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, label: string, filePath: string) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${error.message} (${filePath})`;
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  };

  const readDirectoryEntries = (targetPath: string) =>
    withTimeout(readdir(targetPath, { withFileTypes: true }), FILE_OPERATION_TIMEOUT_MS, "Directory read", targetPath);

  const readFileStats = (targetPath: string) =>
    withTimeout(stat(targetPath), FILE_OPERATION_TIMEOUT_MS, "File stat", targetPath);

  const readMetadataWithTimeout = (filePath: string, libraryRoot?: string, fileNames?: readonly string[]) =>
    withTimeout(readAudioMetadata(filePath, libraryRoot, fileNames), FILE_OPERATION_TIMEOUT_MS, "Metadata read", filePath);

  const readFolderCoverArtModifiedAtWithTimeout = (filePath: string, libraryRoot?: string) =>
    withTimeout(getFolderCoverArtModifiedAt(filePath, libraryRoot), FILE_OPERATION_TIMEOUT_MS, "Cover art stat", filePath);

  const readFolderCoverArtWithTimeout = (filePath: string, libraryRoot?: string) =>
    withTimeout(readFolderCoverArt(filePath, libraryRoot), FILE_OPERATION_TIMEOUT_MS, "Cover art read", filePath);

  const folderNeedsMusicArtifactRefresh = (entries: Awaited<ReturnType<typeof readDirectoryEntries>>) => {
    const fileNames = new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name.toLowerCase())
    );
    const hasArtwork = [...fileNames].some((name) => ARTWORK_EXTENSIONS.has(path.extname(name)));
    const missingSidecar = REQUIRED_MUSIC_SIDECAR_NAMES.some((name) => !fileNames.has(name));
    return missingSidecar || !hasArtwork;
  };

  const scanFolder = async (
    root: string,
    libraryRoot: string,
    collectedTracks: ScannedTrackArtifact[],
    seenPathsSet?: Set<string>,
    options?: {
      forceMediaKind?: "music" | "book";
      folderCoverArtCache?: Map<string, Awaited<ReturnType<typeof readFolderCoverArt>>>;
      folderCoverArtModifiedCache?: Map<string, string | null>;
      existingTracksByPath?: Map<string, TrackRecord>;
      changedArtifactFolders?: Set<string>;
    }
  ): Promise<boolean> => {
    const folderCoverArtCache = options?.folderCoverArtCache ?? new Map<string, Awaited<ReturnType<typeof readFolderCoverArt>>>();
    const folderCoverArtModifiedCache = options?.folderCoverArtModifiedCache ?? new Map<string, string | null>();
    let entries;

    try {
      setPhase("discovering", root, "Reading folder contents");
      entries = await readDirectoryEntries(root);
    } catch (error) {
      pushError(root, error instanceof Error ? error.message : "Failed to read directory");
      return false;
    }

    let completedSuccessfully = true;

    const audioEntries = entries.filter(
      (entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    );
    const entryNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

    if (audioEntries.length > 0) {
      status.totalFiles += audioEntries.length;
      updateProgress();

      if (options?.forceMediaKind !== "book" && folderNeedsMusicArtifactRefresh(entries)) {
        options?.changedArtifactFolders?.add(path.resolve(root));
      }
    }

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);

      if (entry.isDirectory()) {
        const childCompletedSuccessfully = await scanFolder(fullPath, libraryRoot, collectedTracks, seenPathsSet, {
          forceMediaKind: options?.forceMediaKind,
          folderCoverArtCache,
          folderCoverArtModifiedCache,
          existingTracksByPath: options?.existingTracksByPath,
          changedArtifactFolders: options?.changedArtifactFolders
        });
        completedSuccessfully = completedSuccessfully && childCompletedSuccessfully;
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!AUDIO_EXTENSIONS.has(extension)) {
        continue;
      }
      setPhase("reading", fullPath, "Reading track metadata");

      let fileStats;

      try {
        fileStats = await readFileStats(fullPath);
      } catch (error) {
        pushError(fullPath, error instanceof Error ? error.message : "Failed to stat file");
        completedSuccessfully = false;
        status.processedFiles += 1;
        updateProgress();
        continue;
      }

      const normalizedPath = normalizeMediaPath(fullPath);

      if (seenPathsSet) {
        seenPathsSet.add(normalizedPath);
      }

      seenPaths.add(normalizedPath);

      let metadata;
      const forcedBook = options?.forceMediaKind === "book";
      const fileModifiedAt = fileStats.mtime.toISOString();
      const existingTrack =
        options?.existingTracksByPath?.get(normalizedPath) ??
        repository.getTrackByFilePath(fullPath);
      const folderPath = path.dirname(fullPath);
      let trackCoverArtModifiedAt: string | null = null;

      try {
        trackCoverArtModifiedAt = await withTimeout(
          getTrackCoverArtModifiedAt(fullPath, entryNames),
          FILE_OPERATION_TIMEOUT_MS,
          "Track cover art stat",
          fullPath
        );
      } catch (error) {
        pushError(fullPath, error instanceof Error ? error.message : "Failed to read track cover art timestamp");
      }
      let coverArtModifiedAt = folderCoverArtModifiedCache.get(folderPath);

      if (coverArtModifiedAt === undefined) {
        try {
          coverArtModifiedAt = await readFolderCoverArtModifiedAtWithTimeout(fullPath, libraryRoot);
        } catch (error) {
          coverArtModifiedAt = null;
          pushError(fullPath, error instanceof Error ? error.message : "Failed to read cover art timestamp");
        }

        folderCoverArtModifiedCache.set(folderPath, coverArtModifiedAt);
      }

      const effectiveModifiedAt = getEffectiveModifiedAt(fileModifiedAt, coverArtModifiedAt, trackCoverArtModifiedAt);
      const cachedFolderCoverArt = folderCoverArtCache.get(folderPath);
      let currentFolderCoverArt: Awaited<ReturnType<typeof readFolderCoverArt>> | null = cachedFolderCoverArt ?? null;

      if (cachedFolderCoverArt === undefined) {
        try {
          currentFolderCoverArt = await readFolderCoverArtWithTimeout(fullPath, libraryRoot);
        } catch (error) {
          currentFolderCoverArt = null;
          pushError(fullPath, error instanceof Error ? error.message : "Failed to read folder cover art");
        }

        folderCoverArtCache.set(folderPath, currentFolderCoverArt);
      }
      let preloadedMetadata: Awaited<ReturnType<typeof readAudioMetadata>> | null = null;

      if (forcedBook && extension === ".m4b") {
        try {
          preloadedMetadata = await readMetadataWithTimeout(fullPath, libraryRoot, entryNames);
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
        existingTrack.coverArtId !== existingTrack.id &&
        !prefersEmbeddedBookCover &&
        (
          (currentFolderCoverArt?.mimeType ?? null) !== (storedCoverArt?.mimeType ?? null) ||
          !areByteArraysEqual(currentFolderCoverArt?.data ?? null, storedCoverArt?.data ?? null)
        );
      const unchangedTrack =
        existingTrack &&
        existingTrack.modifiedAt === effectiveModifiedAt &&
        existingTrack.sizeBytes === fileStats.size &&
        (options?.forceMediaKind ? existingTrack.mediaKind === options.forceMediaKind : true) &&
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
          metadata = await readMetadataWithTimeout(fullPath, libraryRoot, entryNames);
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
        const useTrackSpecificCover = metadata.coverArtSource === "track";
        const useEmbeddedM4bCover = extension === ".m4b" && metadata.coverArtSource === "embedded";
        metadata = {
          ...metadata,
          mediaKind: "book" as const,
          bookTitle: metadata.bookTitle ?? metadata.album ?? path.basename(path.dirname(fullPath)),
          coverArtMime: useTrackSpecificCover || useEmbeddedM4bCover ? metadata.coverArtMime : currentFolderCoverArt?.mimeType ?? metadata.coverArtMime,
          coverArtData: useTrackSpecificCover || useEmbeddedM4bCover ? metadata.coverArtData : currentFolderCoverArt?.data ?? metadata.coverArtData
        };
      }

      repository.upsertTrack({
        filePath: fullPath,
        format: extension.slice(1),
        modifiedAt: effectiveModifiedAt,
        sizeBytes: fileStats.size,
        ...metadata
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
      options?.changedArtifactFolders?.add(path.resolve(folderPath));
      status.processedFiles += 1;
      updateProgress();
    }

    return completedSuccessfully;
  };

  const runScan = async (reason: ScanReason) => {
    status.isScanning = true;
    status.currentReason = reason;
    status.lastStartedAt = new Date().toISOString();
    status.processedFiles = 0;
    status.totalFiles = 0;
    status.progressPercent = 0;
    status.currentFilePath = null;
    status.currentPhase = "discovering";
    status.currentStepLabel = "Preparing scan";
    status.phaseProcessedItems = 0;
    status.phaseTotalItems = 0;
    status.lastProgressAt = status.lastStartedAt;
    seenPaths.clear();
    const settings = repository.getAppSettings();

    try {
      const scanRoots = uniqueRoots([...settings.libraryRoots, ...settings.bookRoots]);
      const completedScanRoots: string[] = [];

      for (const root of scanRoots) {
        try {
          await access(root);
        } catch (error) {
          pushError(root, error instanceof Error ? error.message : "Failed to access scan root");
          continue;
        }

        const collectedTracks: ScannedTrackArtifact[] = [];
        const isBookRoot = settings.bookRoots.some((bookRoot) => normalizeMediaPath(bookRoot) === normalizeMediaPath(root));
        const existingTracksByPath = new Map(
          repository.listTracksInFolder(root).map((track) => [normalizeMediaPath(track.filePath), track] as const)
        );
        const changedArtifactFolders = new Set<string>();
        const rootCompletedSuccessfully = await scanFolder(root, root, collectedTracks, seenPaths, {
          forceMediaKind: isBookRoot ? "book" : "music",
          folderCoverArtCache: new Map(),
          folderCoverArtModifiedCache: new Map(),
          existingTracksByPath,
          changedArtifactFolders
        });

        if (rootCompletedSuccessfully) {
          completedScanRoots.push(root);
        }

        if (!isBookRoot) {
          for (const [trackedPath, trackedTrack] of existingTracksByPath.entries()) {
            if (!seenPaths.has(trackedPath)) {
              changedArtifactFolders.add(path.resolve(path.dirname(trackedTrack.filePath)));
            }
          }
        }

        if (!isBookRoot) {
          const artifactTracks = collectedTracks.filter((track) =>
            changedArtifactFolders.has(path.resolve(path.dirname(track.filePath)))
          );

          if (artifactTracks.length > 0) {
            setPhase("finalizing", root, "Updating album artwork and metadata sidecars");
            await syncLibraryArtifacts({
              root,
              tracks: artifactTracks,
              pushError,
              discogsAuth
            });
          }
        }
      }

      setPhase("finalizing", null, "Removing missing tracks from completed scan roots");
      repository.pruneMissingTracks(completedScanRoots, seenPaths);
      setPhase("finalizing", "book-state-sidecars", "Restoring book progress sidecars");
      await restoreBookStateSidecars(repository);
      const trackedBookIds = repository.listTrackedBookIds();
      setPhase("finalizing", "book-state-sidecars", "Writing book progress sidecars", 0, trackedBookIds.length);
      for (const [index, bookId] of trackedBookIds.entries()) {
        status.phaseProcessedItems = index;
        status.currentStepLabel = `Writing book progress sidecars (${index + 1} of ${trackedBookIds.length})`;
        markProgress();
        await persistBookStateSidecar(repository, bookId);
        status.phaseProcessedItems = index + 1;
        markProgress();
      }
      setPhase("finalizing", null, "Recording completed scan");
      repository.recordScan({
        completedAt: new Date().toISOString(),
        reason
      });
    } finally {
      status.isScanning = false;
      status.currentReason = null;
      status.lastCompletedAt = new Date().toISOString();
      status.progressPercent = status.totalFiles > 0 ? 100 : 0;
      status.currentFilePath = null;
      status.currentPhase = null;
      status.currentStepLabel = null;
      status.phaseProcessedItems = 0;
      status.phaseTotalItems = 0;
      status.lastProgressAt = status.lastCompletedAt;
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
    status.currentFilePath = null;
    status.currentPhase = "discovering";
    status.currentStepLabel = "Preparing scan";
    status.phaseProcessedItems = 0;
    status.phaseTotalItems = 0;
    status.lastProgressAt = status.lastStartedAt;

    const seenFolderPaths = new Set<string>();

    try {
      try {
        await access(folderPath);
      } catch {
        return;
      }

      const collectedTracks: ScannedTrackArtifact[] = [];
      const settings = repository.getAppSettings();
      const isBookFolderScan = settings.bookRoots.some((bookRoot) => normalizeMediaPath(bookRoot) === normalizeMediaPath(folderPath));
      const existingFolderTracks = repository.listTracksInFolder(folderPath);
      const changedArtifactFolders = new Set<string>();
      const existingTracksByPath = new Map(
        existingFolderTracks.map((track) => [normalizeMediaPath(track.filePath), track] as const)
      );
      const affectedBookIds = new Set(
        existingFolderTracks
          .map((track) => track.bookId)
          .filter((bookId): bookId is string => Boolean(bookId))
      );
      const folderCompletedSuccessfully = await scanFolder(folderPath, folderPath, collectedTracks, seenFolderPaths, {
        forceMediaKind: isBookFolderScan ? "book" : "music",
        folderCoverArtCache: new Map(),
        folderCoverArtModifiedCache: new Map(),
        existingTracksByPath,
        changedArtifactFolders
      });

      if (isBookFolderScan) {
        for (const track of repository.listTracksInFolder(folderPath)) {
          if (track.bookId) {
            affectedBookIds.add(track.bookId);
          }
        }
      }

      if (!isBookFolderScan) {
        for (const [trackedPath, trackedTrack] of existingTracksByPath.entries()) {
          if (!seenFolderPaths.has(trackedPath)) {
            changedArtifactFolders.add(path.resolve(path.dirname(trackedTrack.filePath)));
          }
        }

        const artifactTracks = collectedTracks.filter((track) =>
          changedArtifactFolders.has(path.resolve(path.dirname(track.filePath)))
        );

        if (artifactTracks.length > 0) {
          setPhase("finalizing", folderPath, "Updating album artwork and metadata sidecars");
          await syncLibraryArtifacts({
            root: folderPath,
            tracks: artifactTracks,
            pushError,
            discogsAuth
          });
        }
      }
      if (folderCompletedSuccessfully) {
        setPhase("finalizing", folderPath, "Removing missing tracks from the scanned folder");
        repository.pruneMissingTracksInFolder(folderPath, seenFolderPaths);
      } else {
        setPhase("finalizing", folderPath, "Skipping deletion because the folder scan was incomplete");
      }

      if (isBookFolderScan && affectedBookIds.size > 0) {
        const trackedBookIds = [...affectedBookIds];
        setPhase("finalizing", "book-state-sidecars", "Restoring book progress sidecars", 0, trackedBookIds.length);
        await restoreBookStateSidecars(repository, trackedBookIds);
        setPhase("finalizing", "book-state-sidecars", "Writing book progress sidecars", 0, trackedBookIds.length);
        for (const [index, bookId] of trackedBookIds.entries()) {
          status.phaseProcessedItems = index;
          status.currentStepLabel = `Writing book progress sidecars (${index + 1} of ${trackedBookIds.length})`;
          markProgress();
          await persistBookStateSidecar(repository, bookId);
          status.phaseProcessedItems = index + 1;
          markProgress();
        }
      }

      setPhase("finalizing", null, "Recording completed scan");
      repository.recordScan({
        completedAt: new Date().toISOString(),
        reason
      });
    } finally {
      status.isScanning = false;
      status.currentReason = null;
      status.lastCompletedAt = new Date().toISOString();
      status.progressPercent = status.totalFiles > 0 ? 100 : 0;
      status.currentFilePath = null;
      status.currentPhase = null;
      status.currentStepLabel = null;
      status.phaseProcessedItems = 0;
      status.phaseTotalItems = 0;
      status.lastProgressAt = status.lastCompletedAt;
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
    const tick = () => {
      const now = new Date();
      const minuteKey = getCronMinuteKey(now);

      if (minuteKey !== lastScheduledMinute && cronMatches(repository.getAppSettings().folderScanCron, now)) {
        lastScheduledMinute = minuteKey;
        startScan("scheduled");
      }
    };

    timer = setInterval(() => {
      tick();
    }, 30_000);
  };

  const resetSchedule = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    lastScheduledMinute = getCronMinuteKey();
    schedule();
  };

  return {
    async start() {
      const summary = repository.getLibrarySummary();

      if (summary.trackCount === 0 || !summary.lastScanAt) {
        void runOnce("startup");
      }

      lastScheduledMinute = getCronMinuteKey();
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
