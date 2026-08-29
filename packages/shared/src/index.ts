export type TrackRecord = {
  id: string;
  filePath: string;
  format: string;
  title: string | null;
  mediaKind: "music" | "book";
  bookId: string | null;
  bookTitle: string | null;
  author: string | null;
  artist: string | null;
  artistId: string;
  album: string | null;
  albumId: string;
  albumArtist: string | null;
  albumArtistId: string;
  genre: string | null;
  year: number | null;
  discNumber: number | null;
  trackNumber: number | null;
  durationSeconds: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  modifiedAt: string;
  sizeBytes: number;
  coverArtId: string | null;
};

export type ScanRecord = {
  completedAt: string;
  reason: "startup" | "scheduled" | "manual";
};

export type LibrarySummary = {
  trackCount: number;
  lastScanAt: string | null;
};

export type ArtistRecord = {
  id: string;
  name: string;
  albumCount: number;
};

export type AlbumRecord = {
  id: string;
  artistId: string;
  artist: string;
  name: string;
  songCount: number;
  durationSeconds: number;
  coverArtId: string | null;
};

export type AlbumDetailRecord = {
  album: AlbumRecord;
  tracks: TrackRecord[];
  year: number | null;
  genre: string | null;
  review: string | null;
  outline: string | null;
  artistBiography: string | null;
  artistOutline: string | null;
  artistFolderTitle: string | null;
};

export type BookRecord = {
  id: string;
  title: string;
  author: string;
  trackCount: number;
  durationSeconds: number;
  coverArtId: string | null;
  lastListenedAt: string | null;
  lastTrackId: string | null;
  lastPositionSeconds: number | null;
};

export type BookProgressRecord = {
  bookId: string;
  trackId: string;
  positionSeconds: number;
  updatedAt: string;
};

export type BookBookmarkRecord = {
  id: string;
  bookId: string;
  trackId: string;
  positionSeconds: number;
  label: string | null;
  createdAt: string;
};

export type BookDetailRecord = {
  book: BookRecord;
  tracks: TrackRecord[];
  progress: BookProgressRecord | null;
  bookmarks: BookBookmarkRecord[];
};

export type PlaylistRecord = {
  id: string;
  name: string;
  createdAt: string;
  trackCount: number;
  durationSeconds: number;
  coverArtId: string | null;
  tracks: TrackRecord[];
  description?: string;
  accent?: "cool" | "warm" | "sunset";
  isSmart?: boolean;
};

export type SyncTrackRecord = {
  id: string;
  title: string | null;
  artist: string | null;
  author: string | null;
  album: string | null;
  durationSeconds: number | null;
  format: string;
  sizeBytes: number;
  coverArtId: string | null;
  streamPath: string;
  downloadPath: string;
};

export type AlbumSyncBundle = {
  kind: "album";
  album: AlbumRecord;
  tracks: SyncTrackRecord[];
};

export type BookSyncBundle = {
  kind: "book";
  book: BookRecord;
  tracks: SyncTrackRecord[];
  progress: BookProgressRecord | null;
  bookmarks: BookBookmarkRecord[];
};

export type PlaylistSyncBundle = {
  kind: "playlist";
  playlist: {
    id: string;
    name: string;
    createdAt: string;
    trackCount: number;
    durationSeconds: number;
    coverArtId: string | null;
  };
  tracks: SyncTrackRecord[];
};

export type AppUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
};

export type AppSettings = {
  libraryRoots: string[];
  bookRoots: string[];
  scanIntervalMinutes: number;
  queueAlbumTracksOnPlay: boolean;
  promptBeforeReplacingQueueOnPlay: boolean;
  showEntityMetadataOnHeroImage: boolean;
};

export type UserApiKeyStatus = {
  hasApiKey: boolean;
  preview: string | null;
  createdAt: string | null;
  subsonicUsername: string;
  apiBaseUrl: string;
};

export type GeneratedUserApiKey = {
  apiKey: string;
  status: UserApiKeyStatus;
};

export type AppBootstrap = {
  hasUsers: boolean;
  currentUser: AppUser | null;
  settings: AppSettings;
  needsLibrarySetup: boolean;
  scan: ScanStatus;
};

export type ScanStatus = {
  isScanning: boolean;
  currentReason: "startup" | "scheduled" | "manual" | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  processedFiles: number;
  totalFiles: number;
  progressPercent: number;
  queued: boolean;
  recentErrors: ScanError[];
};

export type ScanError = {
  filePath: string;
  message: string;
  at: string;
};
