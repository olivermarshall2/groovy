import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const openLibraryDatabase = (databasePath: string) => {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");

  database.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      normalized_file_path TEXT NOT NULL UNIQUE,
      format TEXT NOT NULL,
      title TEXT,
      media_kind TEXT NOT NULL DEFAULT 'music',
      book_id TEXT,
      book_title TEXT,
      author TEXT,
      artist TEXT,
      artist_id TEXT NOT NULL,
      album TEXT,
      album_id TEXT NOT NULL,
      album_artist TEXT,
      album_artist_id TEXT NOT NULL,
      genre TEXT,
      year INTEGER,
      disc_number INTEGER,
      track_number INTEGER,
      duration_seconds INTEGER,
      bitrate INTEGER,
      sample_rate INTEGER,
      modified_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      cover_art_id TEXT,
      cover_art_mime TEXT,
      cover_art_data BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      completed_at TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_api_keys (
      user_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      preview TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS play_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      played_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_play_history_user_id ON play_history (user_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_track_id ON play_history (track_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history (played_at);

    CREATE TABLE IF NOT EXISTS liked_tracks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, track_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_liked_tracks_user_id ON liked_tracks (user_id);

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists (user_id);

    CREATE TABLE IF NOT EXISTS playlist_items (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(playlist_id, track_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items (playlist_id);

    CREATE TABLE IF NOT EXISTS user_book_progress (
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position_seconds INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_book_progress_user_id ON user_book_progress (user_id);
    CREATE INDEX IF NOT EXISTS idx_user_book_progress_book_id ON user_book_progress (book_id);

    CREATE TABLE IF NOT EXISTS user_book_progress_state (
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      track_path TEXT NOT NULL,
      position_seconds INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_book_progress_state_user_id ON user_book_progress_state (user_id);
    CREATE INDEX IF NOT EXISTS idx_user_book_progress_state_book_id ON user_book_progress_state (book_id);

    CREATE TABLE IF NOT EXISTS book_bookmarks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position_seconds INTEGER NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_book_bookmarks_user_id_book_id ON book_bookmarks (user_id, book_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS book_bookmark_state (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      track_path TEXT NOT NULL,
      position_seconds INTEGER NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_book_bookmark_state_user_id_book_id ON book_bookmark_state (user_id, book_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS album_media_overrides (
      album_id TEXT PRIMARY KEY,
      media_kind TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>).map((column) => column.name)
  );

  if (!existingColumns.has("album_artist")) {
    database.exec("ALTER TABLE tracks ADD COLUMN album_artist TEXT;");
  }

  if (!existingColumns.has("album_artist_id")) {
    database.exec("ALTER TABLE tracks ADD COLUMN album_artist_id TEXT NOT NULL DEFAULT '';");
  }

  if (!existingColumns.has("year")) {
    database.exec("ALTER TABLE tracks ADD COLUMN year INTEGER;");
  }

  if (!existingColumns.has("disc_number")) {
    database.exec("ALTER TABLE tracks ADD COLUMN disc_number INTEGER;");
  }

  if (!existingColumns.has("track_number")) {
    database.exec("ALTER TABLE tracks ADD COLUMN track_number INTEGER;");
  }

  if (!existingColumns.has("media_kind")) {
    database.exec("ALTER TABLE tracks ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'music';");
  }

  if (!existingColumns.has("book_id")) {
    database.exec("ALTER TABLE tracks ADD COLUMN book_id TEXT;");
  }

  if (!existingColumns.has("book_title")) {
    database.exec("ALTER TABLE tracks ADD COLUMN book_title TEXT;");
  }

  if (!existingColumns.has("author")) {
    database.exec("ALTER TABLE tracks ADD COLUMN author TEXT;");
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks (artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks (album_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_artist_id ON tracks (album_artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_media_kind ON tracks (media_kind);
    CREATE INDEX IF NOT EXISTS idx_tracks_book_id ON tracks (book_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks (title);
    CREATE INDEX IF NOT EXISTS idx_tracks_author ON tracks (author);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks (artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks (album);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks (album_artist);
  `);

  database.exec(`
    INSERT OR IGNORE INTO user_book_progress_state (user_id, book_id, track_path, position_seconds, updated_at)
    SELECT progress.user_id, progress.book_id, tracks.normalized_file_path, progress.position_seconds, progress.updated_at
    FROM user_book_progress AS progress
    JOIN tracks ON tracks.id = progress.track_id;

    INSERT OR IGNORE INTO book_bookmark_state (id, user_id, book_id, track_path, position_seconds, label, created_at)
    SELECT bookmarks.id, bookmarks.user_id, bookmarks.book_id, tracks.normalized_file_path, bookmarks.position_seconds, bookmarks.label, bookmarks.created_at
    FROM book_bookmarks AS bookmarks
    JOIN tracks ON tracks.id = bookmarks.track_id;
  `);

  return database;
};
