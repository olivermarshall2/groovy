import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { TrackRecord } from "@mp3-platform/shared";
import { normalizeGenreLabels, normalizeGenreValue } from "./genre.js";

export type TrackMetadata = Omit<
  TrackRecord,
  "id" | "filePath" | "format" | "modifiedAt" | "sizeBytes" | "coverArtId" | "artistId" | "albumId" | "albumArtistId"
> & {
  coverArtMime: string | null;
  coverArtData: Uint8Array | null;
  coverArtSource: "embedded" | "folder" | "track" | null;
  musicBrainzReleaseId: string | null;
  musicBrainzArtistId: string | null;
  musicBrainzAlbumArtistId: string | null;
};

const IMAGE_EXTENSIONS = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"]
]);

const EXACT_ART_PRIORITY = [
  "cover.jpg",
  "cover.jpeg",
  "folder.jpg",
  "front.jpg",
  "album.jpg",
  "cover.png"
];

type MusicMetadataModule = typeof import("music-metadata");
type ParseFile = MusicMetadataModule["parseFile"];
type ParsedMetadata = Awaited<ReturnType<ParseFile>>;

let parseFilePromise: Promise<ParseFile> | null = null;

const loadParseFile = async () => {
  if (!parseFilePromise) {
    parseFilePromise = import("music-metadata").then((module) => module.parseFile);
  }

  return parseFilePromise;
};

const toArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
};

const uniqueValues = (values: Array<string | null | undefined>) =>
  [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];

const BOOK_PATH_SEGMENTS = new Set(["audiobook", "audiobooks", "book", "books"]);
const BOOK_GENRES = new Set(["audiobook", "audiobooks", "spoken word"]);
const CHAPTER_FOLDER_PATTERN = /^(chapter|chapters|part|parts|disc|disk|cd)\s*[\divxlc]+(?:\b|[^a-z])/i;
const AUTHOR_NATIVE_TAG_KEYS = new Set([
  "author",
  "authors",
  "writer",
  "writers",
  "originalauthor",
  "albumauthor",
  "tsoa",
  "tsoa"
]);
const ARTIST_NATIVE_TAG_KEYS = new Set([
  "artist",
  "artists",
  "tpe1",
  "©art"
]);
const ALBUM_ARTIST_NATIVE_TAG_KEYS = new Set([
  "albumartist",
  "album artist",
  "tpe2",
  "aart"
]);

const scoreImageCandidate = (fileName: string) => {
  const normalized = fileName.toLowerCase();
  const exactIndex = EXACT_ART_PRIORITY.indexOf(normalized);

  if (exactIndex >= 0) {
    return 100 - exactIndex;
  }

  if (normalized.includes("front")) {
    return 80;
  }

  if (normalized.includes("cover")) {
    return 70;
  }

  if (normalized.includes("folder")) {
    return 60;
  }

  if (normalized.includes("album")) {
    return 50;
  }

  return 0;
};

const listArtworkDirectories = (filePath: string, libraryRoot?: string) => {
  const directories: string[] = [];
  let currentDirectory = path.dirname(filePath);
  const resolvedRoot = libraryRoot ? path.resolve(libraryRoot) : null;

  while (true) {
    directories.push(currentDirectory);

    if (resolvedRoot && path.resolve(currentDirectory) === resolvedRoot) {
      break;
    }

    const nextDirectory = path.dirname(currentDirectory);

    if (nextDirectory === currentDirectory) {
      break;
    }

    currentDirectory = nextDirectory;
  }

  return directories;
};

const getTrackArtworkCandidate = async (filePath: string, fileNames?: readonly string[]) => {
  const baseName = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const names = fileNames ?? await readdir(path.dirname(filePath));
  const candidateName = names.find((name) => {
    const extension = path.extname(name).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) && path.basename(name, extension).toLowerCase() === baseName;
  });

  return candidateName ? path.join(path.dirname(filePath), candidateName) : null;
};

export const readTrackCoverArt = async (filePath: string, fileNames?: readonly string[]) => {
  try {
    const candidatePath = await getTrackArtworkCandidate(filePath, fileNames);

    if (!candidatePath) {
      return null;
    }

    return {
      mimeType: IMAGE_EXTENSIONS.get(path.extname(candidatePath).toLowerCase()) ?? "image/jpeg",
      data: new Uint8Array(await readFile(candidatePath))
    };
  } catch {
    return null;
  }
};

export const getTrackCoverArtModifiedAt = async (filePath: string, fileNames?: readonly string[]) => {
  try {
    const candidatePath = await getTrackArtworkCandidate(filePath, fileNames);
    return candidatePath ? (await stat(candidatePath)).mtime.toISOString() : null;
  } catch {
    return null;
  }
};

export const readFolderCoverArt = async (filePath: string, libraryRoot?: string) => {
  const directories = listArtworkDirectories(filePath, libraryRoot);

  for (const directory of directories) {
    const candidates = EXACT_ART_PRIORITY.map((name) => ({ filePath: path.join(directory, name), mimeType: IMAGE_EXTENSIONS.get(path.extname(name)) ?? null }));

    for (const candidate of candidates) {
      if (!candidate.mimeType) {
        continue;
      }

      try {
        const data = await readFile(candidate.filePath);
        return {
          mimeType: candidate.mimeType,
          data: new Uint8Array(data)
        };
      } catch {
        continue;
      }
    }

    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const imageEntries = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort((left, right) => scoreImageCandidate(right) - scoreImageCandidate(left));
      const selectedImage = imageEntries[0];

      if (selectedImage) {
        const data = await readFile(path.join(directory, selectedImage));
        return {
          mimeType: IMAGE_EXTENSIONS.get(path.extname(selectedImage).toLowerCase()) ?? "image/jpeg",
          data: new Uint8Array(data)
        };
      }
    } catch {
      continue;
    }
  }

  return null;
};

export const getFolderCoverArtModifiedAt = async (filePath: string, libraryRoot?: string) => {
  const directories = listArtworkDirectories(filePath, libraryRoot);

  for (const directory of directories) {
    const candidates = EXACT_ART_PRIORITY.map((name) => path.join(directory, name));

    for (const candidatePath of candidates) {
      try {
        const fileStats = await stat(candidatePath);
        return fileStats.mtime.toISOString();
      } catch {
        continue;
      }
    }

    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const imageEntries = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort((left, right) => scoreImageCandidate(right) - scoreImageCandidate(left));
      const selectedImage = imageEntries[0];

      if (selectedImage) {
        const fileStats = await stat(path.join(directory, selectedImage));
        return fileStats.mtime.toISOString();
      }
    } catch {
      continue;
    }
  }

  return null;
};

const getMeaningfulFolderName = (filePath: string, libraryRoot?: string) => {
  const resolvedFileDirectory = path.dirname(path.resolve(filePath));
  const resolvedRoot = libraryRoot ? path.resolve(libraryRoot) : null;
  const relativeDirectory = resolvedRoot ? path.relative(resolvedRoot, resolvedFileDirectory) : resolvedFileDirectory;
  const segments = relativeDirectory.split(path.sep).filter(Boolean);

  if (segments.length === 0) {
    return path.basename(resolvedFileDirectory);
  }

  const bookMarkerIndex = segments.findIndex((segment) => BOOK_PATH_SEGMENTS.has(segment.trim().toLowerCase()));

  if (bookMarkerIndex >= 0) {
    const afterMarker = segments.slice(bookMarkerIndex + 1).filter(Boolean);
    const meaningful = afterMarker.filter((segment) => !CHAPTER_FOLDER_PATTERN.test(segment));
    return meaningful[meaningful.length - 1] ?? afterMarker[afterMarker.length - 1] ?? path.basename(resolvedFileDirectory);
  }

  const reversed = [...segments].reverse();
  return reversed.find((segment) => !CHAPTER_FOLDER_PATTERN.test(segment)) ?? segments[segments.length - 1] ?? path.basename(resolvedFileDirectory);
};

const getNativeAuthorValues = (metadata: ParsedMetadata) => {
  const values: string[] = [];

  for (const tagGroup of Object.values(metadata.native ?? {})) {
    for (const tag of tagGroup) {
      const normalizedId = tag.id.trim().toLowerCase();

      if (!AUTHOR_NATIVE_TAG_KEYS.has(normalizedId)) {
        continue;
      }

      values.push(...toArray(tag.value));
    }
  }

  return uniqueValues(values);
};

const getNativeTagValues = (metadata: ParsedMetadata, keys: Set<string>) => {
  const values: string[] = [];

  for (const tagGroup of Object.values(metadata.native ?? {})) {
    for (const tag of tagGroup) {
      const normalizedId = tag.id.trim().toLowerCase();

      if (!keys.has(normalizedId)) {
        continue;
      }

      values.push(...toArray(tag.value));
    }
  }

  return uniqueValues(values);
};

const inferBookMetadata = (filePath: string, metadata: ParsedMetadata, libraryRoot?: string) => {
  const genres = normalizeGenreLabels(uniqueValues(metadata.common.genre ?? [])).map((genre) => genre.toLowerCase());
  const authorValues = uniqueValues([
    ...(metadata.common as { author?: string | string[] }).author ? toArray((metadata.common as { author?: string | string[] }).author) : [],
    ...getNativeAuthorValues(metadata)
  ]);
  const pathSegments = path
    .resolve(filePath)
    .split(path.sep)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  const hasBookGenre = genres.some((genre) => BOOK_GENRES.has(genre));
  const hasBookPathSegment = pathSegments.some((segment) => BOOK_PATH_SEGMENTS.has(segment));
  const hasAuthorTag = authorValues.length > 0;

  if (!hasBookGenre && !hasBookPathSegment && !hasAuthorTag) {
    return {
      mediaKind: "music" as const,
      bookTitle: null as string | null
    };
  }

  return {
    mediaKind: "book" as const,
    bookTitle: metadata.common.album ?? getMeaningfulFolderName(filePath, libraryRoot)
  };
};

export const readAudioMetadata = async (filePath: string, libraryRoot?: string, fileNames?: readonly string[]): Promise<TrackMetadata> => {
  const parseFile = await loadParseFile();
  const metadata = await parseFile(filePath);
  const embeddedCoverArt = metadata.common.picture?.[0];
  const trackCoverArt = await readTrackCoverArt(filePath, fileNames);
  const folderCoverArt = trackCoverArt || embeddedCoverArt ? null : await readFolderCoverArt(filePath, libraryRoot);
  const artists = toArray(metadata.common.artists);
  const nativeArtistValues = getNativeTagValues(metadata, ARTIST_NATIVE_TAG_KEYS);
  const nativeAlbumArtistValues = getNativeTagValues(metadata, ALBUM_ARTIST_NATIVE_TAG_KEYS);
  const authorValues = uniqueValues([
    ...(metadata.common as { author?: string | string[] }).author ? toArray((metadata.common as { author?: string | string[] }).author) : [],
    ...getNativeAuthorValues(metadata)
  ]);
  const folderArtistName = path.basename(path.dirname(filePath)) || null;
  const artist = nativeArtistValues[0] ?? metadata.common.artist ?? artists[0] ?? folderArtistName;
  const albumArtist = nativeAlbumArtistValues[0] ?? metadata.common.albumartist ?? artist;
  const native = metadata.common as unknown as Record<string, unknown>;
  const musicBrainzArtistId = toArray(native.musicbrainz_artistid)[0] ?? null;
  const musicBrainzAlbumArtistId = toArray(native.musicbrainz_albumartistid)[0] ?? null;
  const inferredBook = inferBookMetadata(filePath, metadata, libraryRoot);
  // Audiobooks use the track Artist tag as the book Author.
  // Album Artist remains available separately and is treated as the narrator-facing field by clients.
  const resolvedAuthor = inferredBook.mediaKind === "book" ? artist : (authorValues[0] ?? null);

  return {
    title: metadata.common.title ?? null,
    mediaKind: inferredBook.mediaKind,
    bookId: null,
    bookTitle: inferredBook.bookTitle,
    author: resolvedAuthor,
    artist,
    album: metadata.common.album ?? null,
    albumArtist,
    genre: normalizeGenreValue(uniqueValues(metadata.common.genre ?? []).join(", ")),
    year: metadata.common.year ?? null,
    discNumber: metadata.common.disk?.no ?? null,
    trackNumber: metadata.common.track?.no ?? null,
    durationSeconds: metadata.format.duration ? Math.round(metadata.format.duration) : null,
    bitrate: metadata.format.bitrate ?? null,
    sampleRate: metadata.format.sampleRate ?? null,
    coverArtMime: trackCoverArt?.mimeType ?? embeddedCoverArt?.format ?? folderCoverArt?.mimeType ?? null,
    coverArtData: trackCoverArt?.data ?? embeddedCoverArt?.data ?? folderCoverArt?.data ?? null,
    coverArtSource: trackCoverArt ? "track" : embeddedCoverArt ? "embedded" : folderCoverArt ? "folder" : null,
    musicBrainzReleaseId: typeof native.musicbrainz_releaseid === "string" ? native.musicbrainz_releaseid : null,
    musicBrainzArtistId,
    musicBrainzAlbumArtistId
  };
};
