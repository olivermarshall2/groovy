import type {
  BookBookmarkRecord,
  BookDetailRecord,
  BookProgressRecord,
  BookRecord,
  AlbumDetailRecord,
  AlbumRecord,
  AppSettings,
  GeneratedUserApiKey,
  AppUser,
  LibrarySummary,
  PlaylistRecord,
  ScanRecord,
  TrackRecord
} from "@mp3-platform/shared";
import { createSessionExpiry, createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "../services/auth.js";
import { normalizeGenreValue } from "../services/genre.js";
import { openLibraryDatabase } from "./schema.js";
import { createStableId, normalizeMediaPath } from "./ids.js";

type TrackUpsert = Omit<TrackRecord, "id" | "coverArtId" | "artistId" | "albumId" | "albumArtistId"> & {
  coverArtMime: string | null;
  coverArtData: Uint8Array | null;
};

type UserSession = {
  user: AppUser;
  token: string;
};

type PlaylistRow = {
  id: string;
  name: string;
  created_at: string;
};

type UserApiKeyRow = {
  user_id: string;
  token_hash: string;
  preview: string;
  created_at: string;
};

type AlbumMediaOverrideRow = {
  media_kind: "music" | "book";
};

type BookProgressStateRow = {
  user_id: string;
  book_id: string;
  track_path: string;
  position_seconds: number;
  updated_at: string;
};

type BookBookmarkStateRow = {
  id: string;
  user_id: string;
  book_id: string;
  track_path: string;
  position_seconds: number;
  label: string | null;
  created_at: string;
};

const UNKNOWN_ARTIST = "Unknown Artist";
const UNKNOWN_ALBUM = "Unknown Album";

export type LibraryRepository = ReturnType<typeof createLibraryRepository>;

const createArtistId = (name: string) => createStableId("artist", name.trim());

const createAlbumId = (artistName: string, albumName: string) =>
  createStableId("album", `${artistName.trim().toLowerCase()}::${albumName.trim().toLowerCase()}`);

const createBookId = (authorName: string, bookTitle: string) =>
  createStableId("book", `${authorName.trim().toLowerCase()}::${bookTitle.trim().toLowerCase()}`);

const mapTrackRow = (row: Record<string, unknown>): TrackRecord => ({
  id: String(row.id),
  filePath: String(row.file_path),
  format: String(row.format),
  title: row.title ? String(row.title) : null,
  mediaKind: row.media_kind === "book" ? "book" : "music",
  bookId: row.book_id ? String(row.book_id) : null,
  bookTitle: row.book_title ? String(row.book_title) : null,
  author: row.author ? String(row.author) : null,
  artist: row.artist ? String(row.artist) : null,
  artistId: String(row.artist_id),
  album: row.album ? String(row.album) : null,
  albumId: String(row.album_id),
  albumArtist: row.album_artist ? String(row.album_artist) : null,
  albumArtistId: String(row.album_artist_id),
  genre: normalizeGenreValue(row.genre ? String(row.genre) : null),
  year: typeof row.year === "number" ? row.year : null,
  discNumber: typeof row.disc_number === "number" ? row.disc_number : null,
  trackNumber: typeof row.track_number === "number" ? row.track_number : null,
  durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : null,
  bitrate: typeof row.bitrate === "number" ? row.bitrate : null,
  sampleRate: typeof row.sample_rate === "number" ? row.sample_rate : null,
  modifiedAt: String(row.modified_at),
  sizeBytes: Number(row.size_bytes),
  coverArtId: row.cover_art_id ? String(row.cover_art_id) : null
});

const mapAlbumRow = (row: Record<string, unknown>): AlbumRecord => ({
  id: String(row.id),
  artistId: String(row.artist_id),
  artist: String(row.artist),
  name: String(row.name),
  songCount: Number(row.song_count),
  durationSeconds: Number(row.duration_seconds ?? 0),
  coverArtId: row.cover_art_id ? String(row.cover_art_id) : null
});

const mapBookRow = (row: Record<string, unknown>): BookRecord => ({
  id: String(row.id),
  title: String(row.title),
  author: String(row.author),
  trackCount: Number(row.track_count),
  durationSeconds: Number(row.duration_seconds ?? 0),
  coverArtId: row.cover_art_id ? String(row.cover_art_id) : null,
  lastListenedAt: row.last_listened_at ? String(row.last_listened_at) : null,
  lastTrackId: row.last_track_id ? String(row.last_track_id) : null,
  lastPositionSeconds: typeof row.last_position_seconds === "number" ? row.last_position_seconds : null
});

const mapBookProgressRow = (row: Record<string, unknown>): BookProgressRecord => ({
  bookId: String(row.book_id),
  trackId: String(row.track_id),
  positionSeconds: Number(row.position_seconds),
  updatedAt: String(row.updated_at)
});

const deriveBooksFromTracks = (tracks: TrackRecord[], userId: string, getLegacyProgress: (bookId: string) => BookProgressRecord | null): BookRecord[] => {
  const booksById = new Map<string, BookRecord>();

  for (const track of tracks) {
    if (track.mediaKind !== "book" || !track.bookId) {
      continue;
    }

    const existing = booksById.get(track.bookId);

    if (existing) {
      existing.trackCount += 1;
      existing.durationSeconds += Math.max(0, track.durationSeconds ?? 0);

      if (!existing.coverArtId && track.coverArtId) {
        existing.coverArtId = track.coverArtId;
      }

      continue;
    }

    const legacyProgress = getLegacyProgress(track.bookId);

    booksById.set(track.bookId, {
      id: track.bookId,
      title: track.bookTitle ?? track.album ?? track.title ?? UNKNOWN_ALBUM,
      author: track.author ?? track.artist ?? track.albumArtist ?? UNKNOWN_ARTIST,
      trackCount: 1,
      durationSeconds: Math.max(0, track.durationSeconds ?? 0),
      coverArtId: track.coverArtId ?? null,
      lastListenedAt: legacyProgress?.updatedAt ?? null,
      lastTrackId: legacyProgress?.bookId === track.bookId ? legacyProgress.trackId : null,
      lastPositionSeconds: legacyProgress?.bookId === track.bookId ? legacyProgress.positionSeconds : null
    });
  }

  return [...booksById.values()].sort((left, right) => {
    const leftTime = left.lastListenedAt ? Date.parse(left.lastListenedAt) : 0;
    const rightTime = right.lastListenedAt ? Date.parse(right.lastListenedAt) : 0;

    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
};

const mapBookProgressStateRow = (row: Record<string, unknown>): BookProgressStateRow => ({
  user_id: String(row.user_id),
  book_id: String(row.book_id),
  track_path: String(row.track_path),
  position_seconds: Number(row.position_seconds),
  updated_at: String(row.updated_at)
});

const mapBookBookmarkRow = (row: Record<string, unknown>): BookBookmarkRecord => ({
  id: String(row.id),
  bookId: String(row.book_id),
  trackId: String(row.track_id),
  positionSeconds: Number(row.position_seconds),
  label: row.label ? String(row.label) : null,
  createdAt: String(row.created_at)
});

const mapBookBookmarkStateRow = (row: Record<string, unknown>): BookBookmarkStateRow => ({
  id: String(row.id),
  user_id: String(row.user_id),
  book_id: String(row.book_id),
  track_path: String(row.track_path),
  position_seconds: Number(row.position_seconds),
  label: row.label ? String(row.label) : null,
  created_at: String(row.created_at)
});

const mapUserRow = (row: Record<string, unknown>): AppUser => ({
  id: String(row.id),
  name: String(row.name),
  email: String(row.email),
  createdAt: String(row.created_at)
});

const parseJsonSetting = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseBooleanSetting = (value: unknown, fallback: boolean) => {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

export const createLibraryRepository = (databasePath: string) => {
  const database = openLibraryDatabase(databasePath);

  const insertTrack = database.prepare(`
    INSERT INTO tracks (
      id, file_path, normalized_file_path, format, title, media_kind, book_id, book_title, author, artist, artist_id, album, album_id,
      album_artist, album_artist_id, genre, year, disc_number, track_number,
      duration_seconds, bitrate, sample_rate, modified_at, size_bytes, cover_art_id,
      cover_art_mime, cover_art_data, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_file_path) DO UPDATE SET
      id = excluded.id,
      file_path = excluded.file_path,
      format = excluded.format,
      title = excluded.title,
      media_kind = excluded.media_kind,
      book_id = excluded.book_id,
      book_title = excluded.book_title,
      author = excluded.author,
      artist = excluded.artist,
      artist_id = excluded.artist_id,
      album = excluded.album,
      album_id = excluded.album_id,
      album_artist = excluded.album_artist,
      album_artist_id = excluded.album_artist_id,
      genre = excluded.genre,
      year = excluded.year,
      disc_number = excluded.disc_number,
      track_number = excluded.track_number,
      duration_seconds = excluded.duration_seconds,
      bitrate = excluded.bitrate,
      sample_rate = excluded.sample_rate,
      modified_at = excluded.modified_at,
      size_bytes = excluded.size_bytes,
      cover_art_id = excluded.cover_art_id,
      cover_art_mime = excluded.cover_art_mime,
      cover_art_data = excluded.cover_art_data,
      updated_at = excluded.updated_at
  `);
  const selectTrackById = database.prepare("SELECT * FROM tracks WHERE id = ?");
  const selectTracks = database.prepare("SELECT * FROM tracks ORDER BY CASE WHEN media_kind = 'book' THEN 1 ELSE 0 END, COALESCE(book_title, album, ''), COALESCE(album_artist, artist, ''), COALESCE(album, ''), COALESCE(disc_number, 0), COALESCE(track_number, 0), COALESCE(title, file_path) COLLATE NOCASE");
  const selectTracksByArtist = database.prepare(`
    SELECT *
    FROM tracks
    WHERE media_kind = 'music' AND COALESCE(NULLIF(album_artist_id, ''), artist_id) = ?
    ORDER BY COALESCE(album_artist, artist, ''), COALESCE(album, ''), COALESCE(disc_number, 0), COALESCE(track_number, 0), COALESCE(title, file_path) COLLATE NOCASE
  `);
  const selectTracksByAlbum = database.prepare("SELECT * FROM tracks WHERE media_kind = 'music' AND album_id = ? ORDER BY COALESCE(disc_number, 0), COALESCE(track_number, 0), COALESCE(title, file_path) COLLATE NOCASE");
  const selectTracksByAlbumGroup = database.prepare("SELECT * FROM tracks WHERE album_id = ? ORDER BY COALESCE(disc_number, 0), COALESCE(track_number, 0), COALESCE(title, file_path) COLLATE NOCASE");
  const selectTracksByBook = database.prepare("SELECT * FROM tracks WHERE media_kind = 'book' AND book_id = ? ORDER BY COALESCE(disc_number, 0), COALESCE(track_number, 0), COALESCE(title, file_path) COLLATE NOCASE");
  const selectTracksInFolder = database.prepare(`
    SELECT *
    FROM tracks
    WHERE normalized_file_path = ? OR normalized_file_path LIKE ?
    ORDER BY normalized_file_path COLLATE NOCASE
  `);
  const selectTrackedPathsInFolder = database.prepare(`
    SELECT normalized_file_path
    FROM tracks
    WHERE normalized_file_path = ? OR normalized_file_path LIKE ?
  `);
  const selectArtists = database.prepare(`
    SELECT
      COALESCE(NULLIF(album_artist_id, ''), artist_id) AS id,
      COALESCE(NULLIF(album_artist, ''), artist, '${UNKNOWN_ARTIST}') AS name,
      COUNT(DISTINCT album_id) AS album_count
    FROM tracks
    WHERE media_kind = 'music'
    GROUP BY COALESCE(NULLIF(album_artist_id, ''), artist_id), COALESCE(NULLIF(album_artist, ''), artist, '${UNKNOWN_ARTIST}')
    ORDER BY name COLLATE NOCASE
  `);
  const selectAlbums = database.prepare(`
    SELECT album_id AS id, album_artist_id AS artist_id, COALESCE(album_artist, artist, '${UNKNOWN_ARTIST}') AS artist,
      COALESCE(album, '${UNKNOWN_ALBUM}') AS name, COUNT(*) AS song_count,
      COALESCE(SUM(duration_seconds), 0) AS duration_seconds, MAX(cover_art_id) AS cover_art_id
    FROM tracks
    WHERE media_kind = 'music'
    GROUP BY album_id, album_artist_id, COALESCE(album_artist, artist, '${UNKNOWN_ARTIST}'), COALESCE(album, '${UNKNOWN_ALBUM}')
    ORDER BY artist COLLATE NOCASE, name COLLATE NOCASE
  `);
  const selectBooks = database.prepare(`
    SELECT
      tracks.book_id AS id,
      COALESCE(tracks.book_title, '${UNKNOWN_ALBUM}') AS title,
      COALESCE(NULLIF(tracks.author, ''), tracks.artist, tracks.album_artist, '${UNKNOWN_ARTIST}') AS author,
      COUNT(*) AS track_count,
      COALESCE(SUM(tracks.duration_seconds), 0) AS duration_seconds,
      MAX(tracks.cover_art_id) AS cover_art_id,
      progress.updated_at AS last_listened_at,
      progress.track_path AS last_track_path,
      progress.position_seconds AS last_position_seconds
    FROM tracks
    LEFT JOIN user_book_progress_state AS progress
      ON progress.book_id = tracks.book_id AND progress.user_id = ?
    WHERE tracks.media_kind = 'book' AND tracks.book_id IS NOT NULL
    GROUP BY
      tracks.book_id,
      COALESCE(tracks.book_title, '${UNKNOWN_ALBUM}'),
      COALESCE(NULLIF(tracks.author, ''), tracks.artist, tracks.album_artist, '${UNKNOWN_ARTIST}'),
      progress.updated_at,
      progress.track_path,
      progress.position_seconds
    ORDER BY COALESCE(progress.updated_at, '') DESC, title COLLATE NOCASE
  `);
  const selectSummary = database.prepare(`
    SELECT COUNT(*) AS track_count, (SELECT completed_at FROM scans ORDER BY id DESC LIMIT 1) AS last_scan_at
    FROM tracks
  `);
  const insertScan = database.prepare("INSERT INTO scans (completed_at, reason) VALUES (?, ?)");
  const selectAllTrackedPaths = database.prepare("SELECT normalized_file_path FROM tracks");
  const deleteTrackByNormalizedPath = database.prepare("DELETE FROM tracks WHERE normalized_file_path = ?");
  const selectCoverArtForTrack = database.prepare("SELECT cover_art_mime, cover_art_data FROM tracks WHERE id = ? AND cover_art_data IS NOT NULL");
  const selectCoverArtForAlbum = database.prepare("SELECT cover_art_mime, cover_art_data FROM tracks WHERE album_id = ? AND cover_art_data IS NOT NULL LIMIT 1");
  const selectCoverArtForBook = database.prepare("SELECT cover_art_mime, cover_art_data FROM tracks WHERE book_id = ? AND cover_art_data IS NOT NULL LIMIT 1");
  const selectCoverArtForArtist = database.prepare(`
    SELECT cover_art_mime, cover_art_data
    FROM tracks
    WHERE (artist_id = ? OR album_artist_id = ?)
      AND cover_art_data IS NOT NULL
    LIMIT 1
  `);
  const selectCoverArtTrackPathForTrack = database.prepare("SELECT file_path FROM tracks WHERE id = ? AND cover_art_data IS NOT NULL LIMIT 1");
  const selectCoverArtTrackPathForAlbum = database.prepare("SELECT file_path FROM tracks WHERE album_id = ? AND cover_art_data IS NOT NULL LIMIT 1");
  const selectCoverArtTrackPathForBook = database.prepare("SELECT file_path FROM tracks WHERE book_id = ? AND cover_art_data IS NOT NULL LIMIT 1");
  const selectCoverArtTrackPathForArtist = database.prepare(`
    SELECT file_path
    FROM tracks
    WHERE (artist_id = ? OR album_artist_id = ?)
      AND cover_art_data IS NOT NULL
    LIMIT 1
  `);
  const deleteAllTracks = database.prepare("DELETE FROM tracks");

  const selectSettings = database.prepare("SELECT key, value FROM app_settings");
  const upsertSetting = database.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const selectAlbumMediaOverride = database.prepare("SELECT media_kind FROM album_media_overrides WHERE album_id = ? LIMIT 1");
  const upsertAlbumMediaOverride = database.prepare(`
    INSERT INTO album_media_overrides (album_id, media_kind, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(album_id) DO UPDATE SET
      media_kind = excluded.media_kind,
      updated_at = excluded.updated_at
  `);
  const updateAlbumTracksClassification = database.prepare(`
    UPDATE tracks
    SET
      media_kind = ?,
      book_id = ?,
      book_title = ?,
      cover_art_id = CASE WHEN cover_art_data IS NOT NULL THEN ? ELSE NULL END,
      updated_at = ?
    WHERE album_id = ?
  `);

  const selectUserCount = database.prepare("SELECT COUNT(*) AS total FROM users");
  const selectUsers = database.prepare("SELECT id, name, email, created_at FROM users ORDER BY created_at ASC");
  const selectUserByEmail = database.prepare("SELECT * FROM users WHERE lower(email) = lower(?)");
  const insertUser = database.prepare("INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)");
  const selectUserBySessionToken = database.prepare(`
    SELECT users.id, users.name, users.email, users.created_at
    FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
    LIMIT 1
  `);
  const insertSession = database.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteSessionByTokenHash = database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?");
  const selectUserApiKeyByUserId = database.prepare("SELECT user_id, token_hash, preview, created_at FROM user_api_keys WHERE user_id = ? LIMIT 1");
  const selectUserApiKeyByTokenHash = database.prepare(`
    SELECT user_api_keys.user_id, user_api_keys.token_hash, user_api_keys.preview, user_api_keys.created_at,
      users.id, users.name, users.email, users.created_at AS user_created_at
    FROM user_api_keys
    JOIN users ON users.id = user_api_keys.user_id
    WHERE user_api_keys.token_hash = ?
    LIMIT 1
  `);
  const upsertUserApiKey = database.prepare(`
    INSERT INTO user_api_keys (user_id, token_hash, preview, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      preview = excluded.preview,
      created_at = excluded.created_at
  `);
  const deleteUserApiKeyByUserId = database.prepare("DELETE FROM user_api_keys WHERE user_id = ?");
  const insertPlayHistory = database.prepare(`
    INSERT INTO play_history (id, user_id, track_id, played_at)
    VALUES (?, ?, ?, ?)
  `);
  const selectRecentlyPlayed = database.prepare(`
    SELECT tracks.*
    FROM play_history
    JOIN tracks ON tracks.id = play_history.track_id
    WHERE play_history.user_id = ?
    ORDER BY play_history.played_at DESC
    LIMIT ?
  `);
  const selectLikedTrackIds = database.prepare("SELECT track_id FROM liked_tracks WHERE user_id = ? ORDER BY created_at DESC");
  const insertLikedTrack = database.prepare(`
    INSERT INTO liked_tracks (id, user_id, track_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, track_id) DO NOTHING
  `);
  const deleteLikedTrack = database.prepare("DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?");
  const selectPlaylists = database.prepare("SELECT id, name, created_at FROM playlists WHERE user_id = ? ORDER BY created_at ASC");
  const insertPlaylist = database.prepare(`
    INSERT INTO playlists (id, user_id, name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO NOTHING
  `);
  const selectPlaylistByName = database.prepare("SELECT id, name, created_at FROM playlists WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1");
  const selectPlaylistItems = database.prepare(`
    SELECT tracks.*
    FROM playlist_items
    JOIN tracks ON tracks.id = playlist_items.track_id
    WHERE playlist_items.playlist_id = ?
    ORDER BY playlist_items.position ASC, playlist_items.created_at ASC
  `);
  const selectMaxPlaylistPosition = database.prepare("SELECT MAX(position) AS max_position FROM playlist_items WHERE playlist_id = ?");
  const insertPlaylistItem = database.prepare(`
    INSERT INTO playlist_items (id, playlist_id, track_id, position, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(playlist_id, track_id) DO NOTHING
  `);
  const selectBookProgressByBook = database.prepare(`
    SELECT book_id, track_id, position_seconds, updated_at
    FROM user_book_progress
    WHERE user_id = ? AND book_id = ?
    LIMIT 1
  `);
  const selectBookProgressStateByBook = database.prepare(`
    SELECT user_id, book_id, track_path, position_seconds, updated_at
    FROM user_book_progress_state
    WHERE user_id = ? AND book_id = ?
    LIMIT 1
  `);
  const upsertBookProgress = database.prepare(`
    INSERT INTO user_book_progress (user_id, book_id, track_id, position_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      track_id = excluded.track_id,
      position_seconds = excluded.position_seconds,
      updated_at = excluded.updated_at
  `);
  const upsertBookProgressState = database.prepare(`
    INSERT INTO user_book_progress_state (user_id, book_id, track_path, position_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      track_path = excluded.track_path,
      position_seconds = excluded.position_seconds,
      updated_at = excluded.updated_at
  `);
  const deleteBookProgress = database.prepare("DELETE FROM user_book_progress WHERE user_id = ? AND book_id = ?");
  const deleteBookProgressState = database.prepare("DELETE FROM user_book_progress_state WHERE user_id = ? AND book_id = ?");
  const selectBookBookmarks = database.prepare(`
    SELECT id, book_id, track_id, position_seconds, label, created_at
    FROM book_bookmarks
    WHERE user_id = ? AND book_id = ?
    ORDER BY created_at DESC
  `);
  const selectBookBookmarkStates = database.prepare(`
    SELECT id, user_id, book_id, track_path, position_seconds, label, created_at
    FROM book_bookmark_state
    WHERE user_id = ? AND book_id = ?
    ORDER BY created_at DESC
  `);
  const insertBookBookmark = database.prepare(`
    INSERT INTO book_bookmarks (id, user_id, book_id, track_id, position_seconds, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBookBookmarkState = database.prepare(`
    INSERT INTO book_bookmark_state (id, user_id, book_id, track_path, position_seconds, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAllBookBookmarks = database.prepare(`
    SELECT id, book_id, track_id, position_seconds, label, created_at
    FROM book_bookmarks
    WHERE user_id = ?
    ORDER BY created_at DESC
  `);
  const selectAllBookBookmarkStates = database.prepare(`
    SELECT id, user_id, book_id, track_path, position_seconds, label, created_at
    FROM book_bookmark_state
    WHERE user_id = ?
    ORDER BY created_at DESC
  `);
  const selectAllBookProgressStateByBook = database.prepare(`
    SELECT user_id, book_id, track_path, position_seconds, updated_at
    FROM user_book_progress_state
    WHERE book_id = ?
    ORDER BY updated_at DESC
  `);
  const selectAllBookBookmarkStatesByBook = database.prepare(`
    SELECT id, user_id, book_id, track_path, position_seconds, label, created_at
    FROM book_bookmark_state
    WHERE book_id = ?
    ORDER BY created_at DESC
  `);
  const selectBookBookmarkStateById = database.prepare(`
    SELECT id, user_id, book_id, track_path, position_seconds, label, created_at
    FROM book_bookmark_state
    WHERE user_id = ? AND id = ?
    LIMIT 1
  `);
  const deleteBookBookmarkById = database.prepare("DELETE FROM book_bookmarks WHERE user_id = ? AND id = ?");
  const deleteBookBookmarkStateById = database.prepare("DELETE FROM book_bookmark_state WHERE user_id = ? AND id = ?");
  const deleteBookBookmarkStatesByUserBook = database.prepare("DELETE FROM book_bookmark_state WHERE user_id = ? AND book_id = ?");
  const selectTrackByNormalizedPath = database.prepare("SELECT * FROM tracks WHERE normalized_file_path = ? LIMIT 1");
  const selectTrackedBookIds = database.prepare("SELECT DISTINCT book_id FROM tracks WHERE media_kind = 'book' AND book_id IS NOT NULL ORDER BY book_id");

  const createSessionForUser = (user: AppUser): UserSession => {
    const token = createSessionToken();
    const now = new Date().toISOString();
    const expiresAt = createSessionExpiry();

    insertSession.run(
      createStableId("session", `${user.id}:${token}`),
      user.id,
      hashSessionToken(token),
      now,
      expiresAt
    );

    return { user, token };
  };

  const getTrackByStoredPath = (trackPath: string) => {
    const row = selectTrackByNormalizedPath.get(normalizeMediaPath(trackPath)) as Record<string, unknown> | undefined;
    return row ? mapTrackRow(row) : null;
  };

  const mapProgressStateToRecord = (row: BookProgressStateRow) => {
    const track = getTrackByStoredPath(row.track_path);

    if (!track || track.bookId !== row.book_id) {
      return null;
    }

    return {
      bookId: row.book_id,
      trackId: track.id,
      positionSeconds: row.position_seconds,
      updatedAt: row.updated_at
    } satisfies BookProgressRecord;
  };

  const mapBookmarkStateToRecord = (row: BookBookmarkStateRow) => {
    const track = getTrackByStoredPath(row.track_path);

    if (!track || track.bookId !== row.book_id) {
      return null;
    }

    return {
      id: row.id,
      bookId: row.book_id,
      trackId: track.id,
      positionSeconds: row.position_seconds,
      label: row.label,
      createdAt: row.created_at
    } satisfies BookBookmarkRecord;
  };

  return {
    close() {
      database.close();
    },
    ensureDefaultSettings(defaultSettings: AppSettings) {
      const rows = selectSettings.all() as Array<{ key: string; value: string }>;

      if (!rows.find((row) => row.key === "libraryRoots")) {
        upsertSetting.run("libraryRoots", JSON.stringify(defaultSettings.libraryRoots));
      }

      if (!rows.find((row) => row.key === "bookRoots")) {
        upsertSetting.run("bookRoots", JSON.stringify(defaultSettings.bookRoots));
      }

      if (!rows.find((row) => row.key === "scanIntervalMinutes")) {
        upsertSetting.run("scanIntervalMinutes", String(defaultSettings.scanIntervalMinutes));
      }

      if (!rows.find((row) => row.key === "queueAlbumTracksOnPlay")) {
        upsertSetting.run("queueAlbumTracksOnPlay", String(defaultSettings.queueAlbumTracksOnPlay));
      }

      if (!rows.find((row) => row.key === "promptBeforeReplacingQueueOnPlay")) {
        upsertSetting.run("promptBeforeReplacingQueueOnPlay", String(defaultSettings.promptBeforeReplacingQueueOnPlay));
      }

      if (!rows.find((row) => row.key === "showEntityMetadataOnHeroImage")) {
        upsertSetting.run("showEntityMetadataOnHeroImage", String(defaultSettings.showEntityMetadataOnHeroImage));
      }

      if (!rows.find((row) => row.key === "mobileOptimizedCoversEnabled")) {
        upsertSetting.run("mobileOptimizedCoversEnabled", String(defaultSettings.mobileOptimizedCoversEnabled));
      }

      if (!rows.find((row) => row.key === "mobileOptimizedCoverJobTime")) {
        upsertSetting.run("mobileOptimizedCoverJobTime", defaultSettings.mobileOptimizedCoverJobTime);
      }
    },
    getAppSettings(): AppSettings {
      const rows = selectSettings.all() as Array<{ key: string; value: string }>;
      const settingsMap = new Map(rows.map((row) => [row.key, row.value]));

      return {
        libraryRoots: parseJsonSetting<string[]>(settingsMap.get("libraryRoots"), []),
        bookRoots: parseJsonSetting<string[]>(settingsMap.get("bookRoots"), []),
        scanIntervalMinutes: Number(settingsMap.get("scanIntervalMinutes") ?? "15"),
        queueAlbumTracksOnPlay: parseBooleanSetting(settingsMap.get("queueAlbumTracksOnPlay"), true),
        promptBeforeReplacingQueueOnPlay: parseBooleanSetting(settingsMap.get("promptBeforeReplacingQueueOnPlay"), true),
        showEntityMetadataOnHeroImage: parseBooleanSetting(settingsMap.get("showEntityMetadataOnHeroImage"), false),
        mobileOptimizedCoversEnabled: parseBooleanSetting(settingsMap.get("mobileOptimizedCoversEnabled"), true),
        mobileOptimizedCoverJobTime: settingsMap.get("mobileOptimizedCoverJobTime") ?? "03:00"
      };
    },
    updateAppSettings(settings: AppSettings) {
      upsertSetting.run("libraryRoots", JSON.stringify(settings.libraryRoots));
      upsertSetting.run("bookRoots", JSON.stringify(settings.bookRoots));
      upsertSetting.run("scanIntervalMinutes", String(settings.scanIntervalMinutes));
      upsertSetting.run("queueAlbumTracksOnPlay", String(settings.queueAlbumTracksOnPlay));
      upsertSetting.run("promptBeforeReplacingQueueOnPlay", String(settings.promptBeforeReplacingQueueOnPlay));
      upsertSetting.run("showEntityMetadataOnHeroImage", String(settings.showEntityMetadataOnHeroImage));
      upsertSetting.run("mobileOptimizedCoversEnabled", String(settings.mobileOptimizedCoversEnabled));
      upsertSetting.run("mobileOptimizedCoverJobTime", settings.mobileOptimizedCoverJobTime);
    },
    hasUsers() {
      const row = selectUserCount.get() as { total: number };
      return Number(row.total) > 0;
    },
    listUsers() {
      return (selectUsers.all() as Record<string, unknown>[]).map(mapUserRow);
    },
    getFirstUser() {
      return this.listUsers()[0] ?? null;
    },
    createInitialUser(input: { name: string; email: string; password: string }): UserSession {
      const now = new Date().toISOString();
      const id = createStableId("user", input.email.toLowerCase());
      insertUser.run(id, input.name, input.email.toLowerCase(), hashPassword(input.password), now);

      return createSessionForUser({
        id,
        name: input.name,
        email: input.email.toLowerCase(),
        createdAt: now
      });
    },
    loginUser(email: string, password: string): UserSession | null {
      const row = selectUserByEmail.get(email.toLowerCase()) as Record<string, unknown> | undefined;

      if (!row || !verifyPassword(password, String(row.password_hash))) {
        return null;
      }

      return createSessionForUser(mapUserRow(row));
    },
    getUserBySessionToken(token: string): AppUser | null {
      const row = selectUserBySessionToken.get(
        hashSessionToken(token),
        new Date().toISOString()
      ) as Record<string, unknown> | undefined;

      return row ? mapUserRow(row) : null;
    },
    deleteSessionToken(token: string) {
      deleteSessionByTokenHash.run(hashSessionToken(token));
    },
    getUserByApiKey(token: string) {
      const row = selectUserApiKeyByTokenHash.get(hashSessionToken(token)) as Record<string, unknown> | undefined;

      if (!row) {
        return null;
      }

      return {
        id: String(row.id),
        name: String(row.name),
        email: String(row.email),
        createdAt: String(row.user_created_at)
      } satisfies AppUser;
    },
    getUserApiKeyStatus(userId: string) {
      const row = selectUserApiKeyByUserId.get(userId) as UserApiKeyRow | undefined;

      return {
        hasApiKey: Boolean(row),
        preview: row?.preview ?? null,
        createdAt: row?.created_at ?? null
      };
    },
    generateUserApiKey(userId: string): GeneratedUserApiKey {
      const apiKey = createSessionToken();
      const createdAt = new Date().toISOString();
      const preview = `••••${apiKey.slice(-4)}`;
      upsertUserApiKey.run(userId, hashSessionToken(apiKey), preview, createdAt);

      return {
        apiKey,
        status: {
          hasApiKey: true,
          preview,
          createdAt,
          subsonicUsername: "",
          apiBaseUrl: ""
        }
      };
    },
    deleteUserApiKey(userId: string) {
      deleteUserApiKeyByUserId.run(userId);
    },
    recordTrackPlay(userId: string, trackId: string, playedAt: string) {
      insertPlayHistory.run(createStableId("play", `${userId}:${trackId}:${playedAt}`), userId, trackId, playedAt);
    },
    listRecentlyPlayed(userId: string, limit = 25) {
      return (selectRecentlyPlayed.all(userId, limit) as Record<string, unknown>[]).map(mapTrackRow);
    },
    listLikedTrackIds(userId: string) {
      return (selectLikedTrackIds.all(userId) as Array<{ track_id: string }>).map((row) => row.track_id);
    },
    listLikedTracks(userId: string) {
      return this.listLikedTrackIds(userId)
        .map((trackId) => this.getTrackById(trackId))
        .filter((track): track is TrackRecord => Boolean(track));
    },
    likeTrack(userId: string, trackId: string) {
      insertLikedTrack.run(createStableId("liked-track", `${userId}:${trackId}`), userId, trackId, new Date().toISOString());
    },
    unlikeTrack(userId: string, trackId: string) {
      deleteLikedTrack.run(userId, trackId);
    },
    listPlaylists(userId: string): PlaylistRecord[] {
      return (selectPlaylists.all(userId) as PlaylistRow[]).map((playlist) => {
        const tracks = (selectPlaylistItems.all(playlist.id) as Record<string, unknown>[]).map(mapTrackRow);

        return {
          id: playlist.id,
          name: playlist.name,
          createdAt: playlist.created_at,
          trackCount: tracks.length,
          durationSeconds: tracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
          coverArtId: tracks.find((track) => track.coverArtId)?.coverArtId ?? null,
          tracks
        };
      });
    },
    getPlaylistById(userId: string, playlistId: string) {
      return this.listPlaylists(userId).find((playlist) => playlist.id === playlistId) ?? null;
    },
    createPlaylist(userId: string, name: string) {
      const normalizedName = name.trim();
      const now = new Date().toISOString();
      const existing = selectPlaylistByName.get(userId, normalizedName) as PlaylistRow | undefined;

      if (existing) {
        return {
          id: existing.id,
          name: existing.name,
          createdAt: existing.created_at
        };
      }

      const id = createStableId("playlist", `${userId}:${normalizedName.toLowerCase()}`);
      insertPlaylist.run(id, userId, normalizedName, now);

      return {
        id,
        name: normalizedName,
        createdAt: now
      };
    },
    addTrackToPlaylist(playlistId: string, trackId: string) {
      const row = selectMaxPlaylistPosition.get(playlistId) as { max_position: number | null };
      const nextPosition = Number(row.max_position ?? -1) + 1;
      insertPlaylistItem.run(createStableId("playlist-item", `${playlistId}:${trackId}`), playlistId, trackId, nextPosition, new Date().toISOString());
    },
    getLibrarySummary(): LibrarySummary {
      const row = selectSummary.get() as Record<string, unknown>;

      return {
        trackCount: Number(row.track_count ?? 0),
        lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null
      };
    },
    listTracks(): TrackRecord[] {
      return (selectTracks.all() as Record<string, unknown>[]).map(mapTrackRow);
    },
    listArtists() {
      return (selectArtists.all() as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        albumCount: Number(row.album_count)
      }));
    },
    listAlbums() {
      const albums = (selectAlbums.all() as Record<string, unknown>[]).map(mapAlbumRow);
      const dedupedAlbums = new Map<string, AlbumRecord>();

      for (const album of albums) {
        if (!dedupedAlbums.has(album.id)) {
          dedupedAlbums.set(album.id, album);
        }
      }

      return [...dedupedAlbums.values()];
    },
    listBooks(userId: string) {
      const legacyProgressForBook = (bookId: string) => {
        const legacyRow = selectBookProgressByBook.get(userId, bookId) as Record<string, unknown> | undefined;
        return legacyRow ? mapBookProgressRow(legacyRow) : null;
      };
      const books = (selectBooks.all(userId) as Record<string, unknown>[]).map((row) => {
        const lastTrackPath = row.last_track_path ? String(row.last_track_path) : null;
        const lastTrack = lastTrackPath ? getTrackByStoredPath(lastTrackPath) : null;
        const legacyProgress = lastTrack
          ? null
          : legacyProgressForBook(String(row.id));

        return {
          ...mapBookRow(row),
          lastTrackId:
            lastTrack?.bookId === String(row.id)
              ? lastTrack.id
              : legacyProgress?.bookId === String(row.id)
                ? legacyProgress.trackId
                : null
        };
      });

      if (books.length > 0) {
        return books;
      }

      return deriveBooksFromTracks(this.listTracksByBookLibrary(), userId, legacyProgressForBook);
    },
    getBookById(userId: string, bookId: string) {
      return this.listBooks(userId).find((book) => book.id === bookId) ?? null;
    },
    getArtistById(artistId: string) {
      return this.listArtists().find((artist) => artist.id === artistId) ?? null;
    },
    getAlbumById(albumId: string) {
      return this.listAlbums().find((album) => album.id === albumId) ?? null;
    },
    listTracksByArtist(artistId: string) {
      return (selectTracksByArtist.all(artistId) as Record<string, unknown>[]).map(mapTrackRow);
    },
    listTracksByAlbum(albumId: string) {
      return (selectTracksByAlbum.all(albumId) as Record<string, unknown>[]).map(mapTrackRow);
    },
    listTracksByAlbumGroup(albumId: string) {
      return (selectTracksByAlbumGroup.all(albumId) as Record<string, unknown>[]).map(mapTrackRow);
    },
    listTracksByBook(bookId: string) {
      return (selectTracksByBook.all(bookId) as Record<string, unknown>[]).map(mapTrackRow);
    },
    listTracksInFolder(folderPath: string) {
      const normalizedFolder = normalizeMediaPath(folderPath).replace(/\/+$/, "");
      const normalizedPrefix = `${normalizedFolder}/%`;
      return (selectTracksInFolder.all(normalizedFolder, normalizedPrefix) as Record<string, unknown>[]).map(mapTrackRow);
    },
    listTracksByBookLibrary() {
      return this.listTracks().filter((track) => track.mediaKind === "book" && Boolean(track.bookId));
    },
    getTrackById(trackId: string) {
      const row = selectTrackById.get(trackId) as Record<string, unknown> | undefined;
      return row ? mapTrackRow(row) : null;
    },
    getTrackByFilePath(filePath: string) {
      return getTrackByStoredPath(filePath);
    },
    upsertTrack(track: TrackUpsert) {
      const artistName = track.artist ?? UNKNOWN_ARTIST;
      const albumArtistName = track.albumArtist ?? track.artist ?? UNKNOWN_ARTIST;
      const bookAuthorName = track.author ?? track.artist ?? albumArtistName;
      const albumName = track.album ?? UNKNOWN_ALBUM;
      const normalizedFilePath = normalizeMediaPath(track.filePath);
      const now = new Date().toISOString();
      const artistId = createArtistId(artistName);
      const albumArtistId = createArtistId(albumArtistName);
      const albumId = createAlbumId(albumArtistName, albumName);
      const override = selectAlbumMediaOverride.get(albumId) as AlbumMediaOverrideRow | undefined;
      const mediaKind = override?.media_kind ?? track.mediaKind;
      const bookTitle = mediaKind === "book" ? track.bookTitle ?? albumName : null;
      const bookId = mediaKind === "book" && bookTitle ? createBookId(bookAuthorName, bookTitle) : null;
      const id = createStableId("track", normalizedFilePath);
      const coverArtId = track.coverArtData ? (mediaKind === "book" ? bookId : albumId) : null;
      const normalizedGenre = normalizeGenreValue(track.genre);

      insertTrack.run(
        id,
        track.filePath,
        normalizedFilePath,
        track.format,
        track.title,
        mediaKind,
        bookId,
        bookTitle,
        track.author,
        track.artist,
        artistId,
        track.album,
        albumId,
        track.albumArtist,
        albumArtistId,
        normalizedGenre,
        track.year,
        track.discNumber,
        track.trackNumber,
        track.durationSeconds,
        track.bitrate,
        track.sampleRate,
        track.modifiedAt,
        track.sizeBytes,
        coverArtId,
        track.coverArtMime,
        track.coverArtData,
        now,
        now
      );
    },
    classifyAlbumMediaKind(albumId: string, mediaKind: "music" | "book") {
      const tracks = this.listTracksByAlbumGroup(albumId);

      if (tracks.length === 0) {
        return null;
      }

      const firstTrack = tracks[0]!;
      const authorName = firstTrack.author ?? firstTrack.artist ?? firstTrack.albumArtist ?? UNKNOWN_ARTIST;
      const albumName = firstTrack.album ?? UNKNOWN_ALBUM;
      const bookId = mediaKind === "book" ? createBookId(authorName, albumName) : null;
      const coverArtId = mediaKind === "book" ? bookId : albumId;
      const now = new Date().toISOString();

      upsertAlbumMediaOverride.run(albumId, mediaKind, now);
      updateAlbumTracksClassification.run(
        mediaKind,
        bookId,
        mediaKind === "book" ? albumName : null,
        coverArtId,
        now,
        albumId
      );

      return {
        albumId,
        mediaKind,
        bookId
      };
    },
    getBookProgress(userId: string, bookId: string) {
      const stateRow = selectBookProgressStateByBook.get(userId, bookId) as Record<string, unknown> | undefined;

      if (stateRow) {
        const mappedState = mapProgressStateToRecord(mapBookProgressStateRow(stateRow));

        if (mappedState) {
          return mappedState;
        }
      }

      const legacyRow = selectBookProgressByBook.get(userId, bookId) as Record<string, unknown> | undefined;
      return legacyRow ? mapBookProgressRow(legacyRow) : null;
    },
    saveBookProgress(userId: string, bookId: string, trackId: string, positionSeconds: number) {
      const normalizedPosition = Math.max(0, Math.floor(positionSeconds));

      if (normalizedPosition <= 0) {
        deleteBookProgress.run(userId, bookId);
        deleteBookProgressState.run(userId, bookId);
        return;
      }

      const track = this.getTrackById(trackId);

      if (!track || track.bookId !== bookId) {
        return;
      }

      const now = new Date().toISOString();
      const normalizedPath = normalizeMediaPath(track.filePath);
      upsertBookProgress.run(userId, bookId, trackId, normalizedPosition, now);
      upsertBookProgressState.run(userId, bookId, normalizedPath, normalizedPosition, now);
    },
    listBookBookmarks(userId: string, bookId: string) {
      const stateRows = (selectBookBookmarkStates.all(userId, bookId) as Record<string, unknown>[]).map(mapBookBookmarkStateRow);

      if (stateRows.length > 0) {
        return stateRows.map(mapBookmarkStateToRecord).filter((bookmark): bookmark is BookBookmarkRecord => Boolean(bookmark));
      }

      return (selectBookBookmarks.all(userId, bookId) as Record<string, unknown>[]).map(mapBookBookmarkRow);
    },
    listAllBookBookmarks(userId: string) {
      const stateRows = (selectAllBookBookmarkStates.all(userId) as Record<string, unknown>[]).map(mapBookBookmarkStateRow);

      if (stateRows.length > 0) {
        return stateRows.map(mapBookmarkStateToRecord).filter((bookmark): bookmark is BookBookmarkRecord => Boolean(bookmark));
      }

      return (selectAllBookBookmarks.all(userId) as Record<string, unknown>[]).map(mapBookBookmarkRow);
    },
    createBookBookmark(userId: string, bookId: string, trackId: string, positionSeconds: number, label: string | null) {
      const track = this.getTrackById(trackId);

      if (!track || track.bookId !== bookId) {
        throw new Error("Book track not found");
      }

      const now = new Date().toISOString();
      const normalizedPosition = Math.max(0, Math.floor(positionSeconds));
      const normalizedLabel = label?.trim() ? label.trim() : null;
      const id = createStableId("book-bookmark", `${userId}:${bookId}:${trackId}:${normalizedPosition}:${now}`);
      const normalizedPath = normalizeMediaPath(track.filePath);

      insertBookBookmark.run(id, userId, bookId, trackId, normalizedPosition, normalizedLabel, now);
      insertBookBookmarkState.run(id, userId, bookId, normalizedPath, normalizedPosition, normalizedLabel, now);
      return {
        id,
        bookId,
        trackId,
        positionSeconds: normalizedPosition,
        label: normalizedLabel,
        createdAt: now
      } satisfies BookBookmarkRecord;
    },
    deleteBookBookmark(userId: string, bookmarkId: string) {
      deleteBookBookmarkById.run(userId, bookmarkId);
      deleteBookBookmarkStateById.run(userId, bookmarkId);
    },
    getBookBookmarkById(userId: string, bookmarkId: string) {
      const row = selectBookBookmarkStateById.get(userId, bookmarkId) as Record<string, unknown> | undefined;
      const bookmark = row ? mapBookmarkStateToRecord(mapBookBookmarkStateRow(row)) : null;
      return bookmark;
    },
    getBookDetail(userId: string, bookId: string): BookDetailRecord | null {
      const tracks = this.listTracksByBook(bookId);
      const fallbackBook = tracks.length > 0
        ? deriveBooksFromTracks(tracks, userId, (targetBookId) => {
            const legacyRow = selectBookProgressByBook.get(userId, targetBookId) as Record<string, unknown> | undefined;
            return legacyRow ? mapBookProgressRow(legacyRow) : null;
          })[0] ?? null
        : null;
      const book = this.getBookById(userId, bookId) ?? fallbackBook;

      if (!book) {
        return null;
      }

      return {
        book,
        tracks,
        progress: this.getBookProgress(userId, bookId),
        bookmarks: this.listBookBookmarks(userId, bookId)
      };
    },
    listTrackedBookIds() {
      return (selectTrackedBookIds.all() as Array<{ book_id: string | null }>)
        .map((row) => row.book_id)
        .filter((bookId): bookId is string => Boolean(bookId));
    },
    exportBookState(bookId: string) {
      const tracks = this.listTracksByBook(bookId);

      if (tracks.length === 0) {
        return null;
      }

      const bookTitle = tracks[0]?.bookTitle ?? tracks[0]?.album ?? "Unknown Book";
      const progressEntries = (selectAllBookProgressStateByBook.all(bookId) as Record<string, unknown>[]).map(mapBookProgressStateRow);
      const bookmarkEntries = (selectAllBookBookmarkStatesByBook.all(bookId) as Record<string, unknown>[]).map(mapBookBookmarkStateRow);

      return {
        bookId,
        bookTitle,
        tracks,
        progressEntries,
        bookmarkEntries
      };
    },
    importBookState(bookId: string, state: {
      progressEntries: BookProgressStateRow[];
      bookmarkEntries: BookBookmarkStateRow[];
    }) {
      const now = new Date().toISOString();
      const progressByUser = new Map<string, BookProgressStateRow>();

      for (const entry of state.progressEntries) {
        if (entry.book_id !== bookId) {
          continue;
        }

        progressByUser.set(entry.user_id, {
          ...entry,
          updated_at: entry.updated_at || now,
          track_path: normalizeMediaPath(entry.track_path)
        });
      }

      for (const [userId, entry] of progressByUser) {
        upsertBookProgressState.run(userId, bookId, entry.track_path, Math.max(0, Math.floor(entry.position_seconds)), entry.updated_at);
      }

      const bookmarkUserIds = [...new Set(state.bookmarkEntries.map((entry) => entry.user_id))];

      for (const userId of bookmarkUserIds) {
        deleteBookBookmarkStatesByUserBook.run(userId, bookId);
      }

      for (const entry of state.bookmarkEntries) {
        if (entry.book_id !== bookId) {
          continue;
        }

        insertBookBookmarkState.run(
          entry.id,
          entry.user_id,
          bookId,
          normalizeMediaPath(entry.track_path),
          Math.max(0, Math.floor(entry.position_seconds)),
          entry.label ?? null,
          entry.created_at || now
        );
      }
    },
    recordScan(scan: ScanRecord) {
      insertScan.run(scan.completedAt, scan.reason);
    },
    pruneMissingTracks(libraryRoots: string[], seenPaths: Set<string>) {
      const normalizedRoots = libraryRoots.map((root) => normalizeMediaPath(root));
      const rows = selectAllTrackedPaths.all() as Array<{ normalized_file_path: string }>;

      for (const row of rows) {
        const trackedPath = row.normalized_file_path;
        const belongsToCurrentRoots =
          normalizedRoots.length === 0 ||
          normalizedRoots.some((root) => trackedPath.startsWith(root));

        if (!belongsToCurrentRoots || !seenPaths.has(trackedPath)) {
          deleteTrackByNormalizedPath.run(trackedPath);
        }
      }
    },
    pruneMissingTracksInFolder(folderPath: string, seenPaths: Set<string>) {
      const normalizedFolder = normalizeMediaPath(folderPath).replace(/\/+$/, "");
      const normalizedPrefix = `${normalizedFolder}/%`;
      const rows = selectTrackedPathsInFolder.all(normalizedFolder, normalizedPrefix) as Array<{ normalized_file_path: string }>;

      for (const row of rows) {
        const trackedPath = row.normalized_file_path;

        if (seenPaths.has(trackedPath)) {
          continue;
        }

        deleteTrackByNormalizedPath.run(trackedPath);
      }
    },
    getCoverArtById(id: string) {
      let row = selectCoverArtForTrack.get(id) as Record<string, unknown> | undefined;

      if (!row && id.startsWith("album:")) {
        row = selectCoverArtForAlbum.get(id) as Record<string, unknown> | undefined;
      }

      if (!row && id.startsWith("book:")) {
        row = selectCoverArtForBook.get(id) as Record<string, unknown> | undefined;
      }

      if (!row && id.startsWith("artist:")) {
        row = selectCoverArtForArtist.get(id, id) as Record<string, unknown> | undefined;
      }

      if (!row) {
        return null;
      }

      return {
        mimeType: String(row.cover_art_mime),
        data: row.cover_art_data as Uint8Array
      };
    },
    getCoverArtTrackPathById(id: string) {
      let row = selectCoverArtTrackPathForTrack.get(id) as Record<string, unknown> | undefined;

      if (!row && id.startsWith("album:")) {
        row = selectCoverArtTrackPathForAlbum.get(id) as Record<string, unknown> | undefined;
      }

      if (!row && id.startsWith("book:")) {
        row = selectCoverArtTrackPathForBook.get(id) as Record<string, unknown> | undefined;
      }

      if (!row && id.startsWith("artist:")) {
        row = selectCoverArtTrackPathForArtist.get(id, id) as Record<string, unknown> | undefined;
      }

      return row?.file_path ? String(row.file_path) : null;
    }
  };
};
