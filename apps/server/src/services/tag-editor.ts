import { spawn } from "node:child_process";
import { rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { TrackRecord } from "@mp3-platform/shared";
import type { DiscogsAuth } from "./discogs.js";
import { type ScannedTrackArtifact, syncLibraryArtifacts } from "./library-artifacts.js";
import { persistBookStateSidecar } from "./book-state-sidecar.js";
import { getFolderCoverArtModifiedAt, readAudioMetadata, readFolderCoverArt } from "./tag-reader.js";
import type { LibraryRepository } from "../storage/library-repository.js";
import { normalizeMediaPath } from "../storage/ids.js";

type Logger = {
  warn: (data: Record<string, unknown>, message: string) => void;
};

type AlbumTagChanges = {
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
};

type TrackTagChanges = {
  title: string | null;
  trackNumber: number | null;
  discNumber: number | null;
};

const isPathInsideRoot = (filePath: string, rootPath: string) => {
  const normalizedFilePath = normalizeMediaPath(filePath).replace(/\/+$/, "");
  const normalizedRoot = normalizeMediaPath(rootPath).replace(/\/+$/, "");

  return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}/`);
};

const resolveOwningRoot = (filePath: string, roots: string[]) =>
  [...roots]
    .filter((root) => root.trim().length > 0 && isPathInsideRoot(filePath, root))
    .sort((left, right) => normalizeMediaPath(right).length - normalizeMediaPath(left).length)[0] ?? null;

const getEffectiveModifiedAt = (fileModifiedAt: string, coverArtModifiedAt: string | null) => {
  if (!coverArtModifiedAt) {
    return fileModifiedAt;
  }

  return coverArtModifiedAt > fileModifiedAt ? coverArtModifiedAt : fileModifiedAt;
};

const resolveCommonFolder = (paths: string[]) => {
  if (paths.length === 0) {
    return null;
  }

  const splitPath = (value: string) =>
    path
      .resolve(value)
      .split(path.sep)
      .filter(Boolean);

  const [firstPath, ...remainingPaths] = paths.map(splitPath);
  const sharedParts = [...firstPath];

  for (const currentPath of remainingPaths) {
    let index = 0;

    while (index < sharedParts.length && index < currentPath.length && sharedParts[index]?.toLowerCase() === currentPath[index]?.toLowerCase()) {
      index += 1;
    }

    sharedParts.length = index;

    if (sharedParts.length === 0) {
      break;
    }
  }

  return sharedParts.length > 0 ? sharedParts.join(path.sep) : null;
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

const runFfmpeg = async (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? "unknown"}`));
    });
  });

const replaceFileAtomically = async (originalPath: string, replacementPath: string) => {
  const directory = path.dirname(originalPath);
  const baseName = path.basename(originalPath);
  const backupPath = path.join(directory, `.${baseName}.mp3-platform-backup-${Date.now()}`);

  await rename(originalPath, backupPath);

  try {
    await rename(replacementPath, originalPath);
    await unlink(backupPath);
  } catch (error) {
    try {
      await rename(backupPath, originalPath);
    } catch {
      // Best-effort rollback only.
    }

    try {
      await unlink(replacementPath);
    } catch {
      // Ignore cleanup failures.
    }

    throw error;
  }
};

const writeMetadataToFile = async (track: TrackRecord, updates: Record<string, string | null>) => {
  const directory = path.dirname(track.filePath);
  const extension = path.extname(track.filePath);
  const baseName = path.basename(track.filePath, extension);
  const outputPath = path.join(directory, `.${baseName}.mp3-platform-edit-${Date.now()}${extension}`);
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    track.filePath,
    "-map",
    "0",
    "-c",
    "copy",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0"
  ];

  for (const [key, value] of Object.entries(updates)) {
    args.push("-metadata", `${key}=${value ?? ""}`);
  }

  if (track.format === "mp3") {
    args.push("-id3v2_version", "3");
  }

  if (track.format === "m4b" || track.format === "m4a" || track.format === "mp4") {
    args.push("-movflags", "use_metadata_tags");
  }

  args.push(outputPath);

  try {
    await runFfmpeg(args);
    await replaceFileAtomically(track.filePath, outputPath);
  } finally {
    try {
      await unlink(outputPath);
    } catch {
      // Ignore cleanup failures.
    }
  }
};

const refreshTrackFromFile = async (repository: LibraryRepository, filePath: string) => {
  const settings = repository.getAppSettings();
  const allRoots = [...settings.libraryRoots, ...settings.bookRoots];
  const libraryRoot = resolveOwningRoot(filePath, allRoots) ?? undefined;
  const forcedBook = settings.bookRoots.some((bookRoot) => isPathInsideRoot(filePath, bookRoot));
  const existingTrack = repository.getTrackByFilePath(filePath);
  const trackStats = await stat(filePath);
  const metadata = await readAudioMetadata(filePath, libraryRoot);
  const folderCoverArt = await readFolderCoverArt(filePath, libraryRoot);
  const coverArtModifiedAt = await getFolderCoverArtModifiedAt(filePath, libraryRoot);
  const effectiveModifiedAt = getEffectiveModifiedAt(trackStats.mtime.toISOString(), coverArtModifiedAt);
  const trackFormat = existingTrack?.format ?? path.extname(filePath).slice(1).toLowerCase();
  const useEmbeddedM4bCover = forcedBook && trackFormat === "m4b" && metadata.coverArtSource === "embedded";
  const persistedMetadata = forcedBook
    ? {
        ...metadata,
        mediaKind: "book" as const,
        bookTitle: metadata.bookTitle ?? metadata.album ?? path.basename(path.dirname(filePath)),
        coverArtMime: useEmbeddedM4bCover ? metadata.coverArtMime : folderCoverArt?.mimeType ?? metadata.coverArtMime,
        coverArtData: useEmbeddedM4bCover ? metadata.coverArtData : folderCoverArt?.data ?? metadata.coverArtData
      }
    : metadata;

  repository.upsertTrack({
    filePath,
    format: trackFormat,
    modifiedAt: effectiveModifiedAt,
    sizeBytes: trackStats.size,
    ...persistedMetadata
  });

  return repository.getTrackByFilePath(filePath);
};

const syncMusicArtifactsForTracks = async (
  repository: LibraryRepository,
  tracks: TrackRecord[],
  discogsAuth: DiscogsAuth | null,
  logger: Logger
) => {
  if (tracks.length === 0) {
    return;
  }

  const root = resolveCommonFolder(tracks.map((track) => path.dirname(track.filePath))) ?? path.dirname(tracks[0]!.filePath);
  await syncLibraryArtifacts({
    root,
    tracks: tracks.map(toArtifactTrack),
    pushError: (filePath, message) => {
      logger.warn({ filePath, message }, "Metadata update sidecar sync warning");
    },
    discogsAuth
  });
};

export const updateAlbumTags = async (
  repository: LibraryRepository,
  albumId: string,
  changes: AlbumTagChanges,
  discogsAuth: DiscogsAuth | null,
  logger: Logger
) => {
  const tracks = repository.listTracksByAlbumGroup(albumId);

  if (tracks.length === 0) {
    return null;
  }

  for (const track of tracks) {
    await writeMetadataToFile(track, {
      artist: changes.artist,
      album_artist: changes.albumArtist,
      album: changes.album,
      genre: changes.genre,
      date: changes.year ? String(changes.year) : null,
      year: changes.year ? String(changes.year) : null
    });
  }

  const refreshedTracks: TrackRecord[] = [];

  for (const track of tracks) {
    const refreshedTrack = await refreshTrackFromFile(repository, track.filePath);

    if (refreshedTrack) {
      refreshedTracks.push(refreshedTrack);
    }
  }

  const nextAlbumId = refreshedTracks[0]?.albumId ?? null;

  if (!nextAlbumId) {
    return null;
  }

  const nextAlbumTracks = repository.listTracksByAlbumGroup(nextAlbumId);
  await syncMusicArtifactsForTracks(repository, nextAlbumTracks, discogsAuth, logger);

  return {
    albumId: nextAlbumId,
    tracks: nextAlbumTracks
  };
};

export const updateTrackTags = async (
  repository: LibraryRepository,
  trackId: string,
  changes: TrackTagChanges,
  discogsAuth: DiscogsAuth | null,
  logger: Logger
) => {
  const track = repository.getTrackById(trackId);

  if (!track) {
    return null;
  }

  await writeMetadataToFile(track, {
    title: changes.title,
    track: changes.trackNumber ? String(changes.trackNumber) : null,
    tracknumber: changes.trackNumber ? String(changes.trackNumber) : null,
    disc: changes.discNumber ? String(changes.discNumber) : null,
    disk: changes.discNumber ? String(changes.discNumber) : null
  });

  const refreshedTrack = await refreshTrackFromFile(repository, track.filePath);

  if (!refreshedTrack) {
    return null;
  }

  if (refreshedTrack.mediaKind === "music") {
    const albumTracks = repository.listTracksByAlbumGroup(refreshedTrack.albumId);
    await syncMusicArtifactsForTracks(repository, albumTracks, discogsAuth, logger);
  }

  if (refreshedTrack.mediaKind === "book" && refreshedTrack.bookId) {
    await persistBookStateSidecar(repository, refreshedTrack.bookId);
  }

  return refreshedTrack;
};
