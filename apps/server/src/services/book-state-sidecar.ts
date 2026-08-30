import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeMediaPath } from "../storage/ids.js";
import type { LibraryRepository } from "../storage/library-repository.js";

const SIDECAR_FILE_NAME = ".groovy-book-state.json";
const LEGACY_SIDECAR_FILE_NAMES = [".mp3-platform-book-state.json"];

type SidecarUserState = {
  progress: {
    trackPath: string;
    positionSeconds: number;
    updatedAt: string;
  } | null;
  bookmarks: Array<{
    id: string;
    trackPath: string;
    positionSeconds: number;
    label: string | null;
    createdAt: string;
  }>;
};

type SidecarState = {
  version: 1;
  bookId: string;
  title: string;
  updatedAt: string;
  users: Record<string, SidecarUserState>;
};

const getBookFolderPath = (filePaths: string[]) => {
  if (filePaths.length === 0) {
    return null;
  }

  const directorySegments = filePaths.map((filePath) => path.resolve(path.dirname(filePath)).split(path.sep));
  const commonSegments = [...directorySegments[0]!];

  for (const segments of directorySegments.slice(1)) {
    let index = 0;

    while (index < commonSegments.length && index < segments.length && commonSegments[index] === segments[index]) {
      index += 1;
    }

    commonSegments.length = index;
  }

  return commonSegments.length > 0 ? commonSegments.join(path.sep) : path.dirname(path.resolve(filePaths[0]!));
};

const toRelativeTrackPath = (bookFolderPath: string, trackPath: string) =>
  normalizeMediaPath(path.relative(bookFolderPath, trackPath).replace(/^\.\//, ""));

const toAbsoluteTrackPath = (bookFolderPath: string, relativeTrackPath: string) =>
  normalizeMediaPath(path.resolve(bookFolderPath, relativeTrackPath));

const getSidecarPath = (bookFolderPath: string) => path.join(bookFolderPath, SIDECAR_FILE_NAME);

const getLegacySidecarPaths = (bookFolderPath: string) =>
  LEGACY_SIDECAR_FILE_NAMES.map((fileName) => path.join(bookFolderPath, fileName));

const isPermissionError = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code !== undefined &&
  ["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code));

export const persistBookStateSidecar = async (repository: LibraryRepository, bookId: string) => {
  const snapshot = repository.exportBookState(bookId);

  if (!snapshot) {
    return;
  }

  const bookFolderPath = getBookFolderPath(snapshot.tracks.map((track) => track.filePath));

  if (!bookFolderPath) {
    return;
  }

  const users: SidecarState["users"] = {};

  for (const entry of snapshot.progressEntries) {
    users[entry.user_id] = {
      progress: {
        trackPath: toRelativeTrackPath(bookFolderPath, entry.track_path),
        positionSeconds: entry.position_seconds,
        updatedAt: entry.updated_at
      },
      bookmarks: users[entry.user_id]?.bookmarks ?? []
    };
  }

  for (const entry of snapshot.bookmarkEntries) {
    const userState = users[entry.user_id] ?? { progress: null, bookmarks: [] };
    userState.bookmarks.push({
      id: entry.id,
      trackPath: toRelativeTrackPath(bookFolderPath, entry.track_path),
      positionSeconds: entry.position_seconds,
      label: entry.label,
      createdAt: entry.created_at
    });
    users[entry.user_id] = userState;
  }

  const payload: SidecarState = {
    version: 1,
    bookId,
    title: snapshot.bookTitle,
    updatedAt: new Date().toISOString(),
    users
  };

  try {
    await mkdir(bookFolderPath, { recursive: true });
    await writeFile(getSidecarPath(bookFolderPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    for (const legacySidecarPath of getLegacySidecarPaths(bookFolderPath)) {
      try {
        await rm(legacySidecarPath, { force: true });
      } catch (error) {
        if (!isPermissionError(error)) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (isPermissionError(error)) {
      return;
    }

    throw error;
  }
};

export const restoreBookStateSidecars = async (repository: LibraryRepository, bookIds?: string[]) => {
  const targetBookIds = bookIds ?? repository.listTrackedBookIds();

  for (const bookId of targetBookIds) {
    const snapshot = repository.exportBookState(bookId);

    if (!snapshot) {
      continue;
    }

    const bookFolderPath = getBookFolderPath(snapshot.tracks.map((track) => track.filePath));

    if (!bookFolderPath) {
      continue;
    }

    let content: string;

    try {
      content = await readFile(getSidecarPath(bookFolderPath), "utf8");
    } catch {
      let restoredLegacyContent: string | null = null;

      for (const legacySidecarPath of getLegacySidecarPaths(bookFolderPath)) {
        try {
          restoredLegacyContent = await readFile(legacySidecarPath, "utf8");
          break;
        } catch {
          continue;
        }
      }

      if (!restoredLegacyContent) {
        continue;
      }

      content = restoredLegacyContent;
    }

    try {
      const parsed = JSON.parse(content) as Partial<SidecarState>;
      const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
      const progressEntries: Array<{
        user_id: string;
        book_id: string;
        track_path: string;
        position_seconds: number;
        updated_at: string;
      }> = [];
      const bookmarkEntries: Array<{
        id: string;
        user_id: string;
        book_id: string;
        track_path: string;
        position_seconds: number;
        label: string | null;
        created_at: string;
      }> = [];

      for (const [userId, state] of Object.entries(users)) {
        if (!state || typeof state !== "object") {
          continue;
        }

        const progress = "progress" in state ? state.progress : null;

        if (progress && typeof progress === "object" && typeof progress.trackPath === "string") {
          progressEntries.push({
            user_id: userId,
            book_id: bookId,
            track_path: toAbsoluteTrackPath(bookFolderPath, progress.trackPath),
            position_seconds: Number(progress.positionSeconds ?? 0),
            updated_at: typeof progress.updatedAt === "string" ? progress.updatedAt : new Date().toISOString()
          });
        }

        const bookmarks = Array.isArray("bookmarks" in state ? state.bookmarks : null) ? state.bookmarks : [];

        for (const bookmark of bookmarks) {
          if (!bookmark || typeof bookmark !== "object" || typeof bookmark.trackPath !== "string") {
            continue;
          }

          bookmarkEntries.push({
            id: typeof bookmark.id === "string" ? bookmark.id : `${userId}:${bookId}:${bookmark.trackPath}:${bookmark.positionSeconds ?? 0}`,
            user_id: userId,
            book_id: bookId,
            track_path: toAbsoluteTrackPath(bookFolderPath, bookmark.trackPath),
            position_seconds: Number(bookmark.positionSeconds ?? 0),
            label: typeof bookmark.label === "string" ? bookmark.label : null,
            created_at: typeof bookmark.createdAt === "string" ? bookmark.createdAt : new Date().toISOString()
          });
        }
      }

      repository.importBookState(bookId, { progressEntries, bookmarkEntries });
    } catch {
      continue;
    }
  }
};
