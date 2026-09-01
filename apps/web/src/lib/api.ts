import type {
  AlbumDetailRecord,
  AlbumRecord,
  AppBootstrap,
  AppSettings,
  AppUser,
  ArtistRecord,
  BookBookmarkRecord,
  BookDetailRecord,
  BookProgressRecord,
  BookRecord,
  GeneratedUserApiKey,
  LibrarySummary,
  PlaylistRecord,
  TrackRecord
  ,
  UserApiKeyStatus
} from "@mp3-platform/shared";

type SessionResponse = {
  user: AppUser;
  token: string;
};

export type UserPlaylist = PlaylistRecord;

export type AlbumIdentifyCandidate = {
  id: number;
  source: "discogs";
  title: string | null;
  artist: string | null;
  year: number | null;
  country: string | null;
  label: string | null;
  format: string | null;
  thumbUrl: string | null;
};

export type AlbumIdentifyFilters = {
  artist: string;
  albumArtist: string;
  year: string;
  genre: string;
};

export type AlbumIdentifyRequest = {
  candidateId?: number;
  previewOnly?: boolean;
  filters?: Partial<AlbumIdentifyFilters>;
};

export type AlbumIdentifyResponse =
  | {
      identified: true;
      source: "discogs" | "musicbrainz";
      releaseId: number | string | null;
    }
  | {
      status: "needs-selection";
      source: "discogs";
      candidates: AlbumIdentifyCandidate[];
    };

export type AlbumTagsPayload = {
  artist: string;
  albumArtist: string;
  album: string;
  year: string;
  genre: string;
};

export type TrackTagsPayload = {
  title: string;
  trackNumber: string;
  discNumber: string;
};

const SESSION_TOKEN_KEY = "mp3-platform-session-token";

export const getSessionToken = () => window.localStorage.getItem(SESSION_TOKEN_KEY);

export const storeSessionToken = (token: string) => {
  window.localStorage.setItem(SESSION_TOKEN_KEY, token);
};

export const clearSessionToken = () => {
  window.localStorage.removeItem(SESSION_TOKEN_KEY);
};

const getHeaders = () => {
  const token = getSessionToken();

  return token
    ? {
        Authorization: `Bearer ${token}`
      }
    : undefined;
};

const getJson = async <T>(input: string): Promise<T> => {
  const response = await fetch(input, {
    headers: getHeaders()
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${input}`);
  }

  return response.json() as Promise<T>;
};

const sendJson = async <T>(input: string, init: RequestInit): Promise<T> => {
  const headers = {
    ...(getHeaders() ?? {}),
    ...(init.headers ?? {})
  };

  if (init.body && !("Content-Type" in headers)) {
    Object.assign(headers, { "Content-Type": "application/json" });
  }

  const response = await fetch(input, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? `Request failed for ${input}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

export const fetchBootstrap = () => getJson<AppBootstrap>("/api/app/bootstrap");

export const registerFirstUser = (payload: { name: string; email: string; password: string }) =>
  sendJson<SessionResponse>("/api/auth/register-first", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const loginUser = (payload: { email: string; password: string }) =>
  sendJson<SessionResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const logoutUser = () =>
  sendJson<void>("/api/auth/logout", {
    method: "POST"
  });

export const updateSettings = (payload: AppSettings) =>
  sendJson<{ settings: AppSettings }>("/api/app/settings", {
    method: "PUT",
    body: JSON.stringify(payload)
  });

export const fetchAppJobs = () => getJson<AppBootstrap["jobs"]>("/api/app/jobs");

export const runMobileCoverArtJobNow = () =>
  sendJson<{ accepted: boolean; alreadyRunning: boolean; jobs: AppBootstrap["jobs"] }>("/api/app/jobs/mobile-cover-art/run-now", {
    method: "POST"
  });

export const runFolderScanJobNow = () =>
  sendJson<{ accepted: boolean; alreadyRunning: boolean; jobs: AppBootstrap["jobs"] }>("/api/app/jobs/folder-scan/run-now", {
    method: "POST"
  });

export const fetchUserApiKeyStatus = () => getJson<UserApiKeyStatus>("/api/app/api-key");

export const generateUserApiKey = () =>
  sendJson<GeneratedUserApiKey>("/api/app/api-key", {
    method: "POST"
  });

export const deleteUserApiKey = () =>
  sendJson<void>("/api/app/api-key", {
    method: "DELETE"
  });

export const fetchLibrarySummary = () => getJson<LibrarySummary>("/api/library/summary");

export const fetchTracks = () => getJson<TrackRecord[]>("/api/library/tracks");

export const fetchArtists = () => getJson<ArtistRecord[]>("/api/library/artists");

export const fetchAlbums = () => getJson<AlbumRecord[]>("/api/library/albums");
export const fetchBooks = () => getJson<BookRecord[]>("/api/library/books");

export const fetchAlbumDetail = (albumId: string) => getJson<AlbumDetailRecord>(`/api/library/albums/${encodeURIComponent(albumId)}`);
export const fetchBookDetail = (bookId: string) => getJson<BookDetailRecord>(`/api/library/books/${encodeURIComponent(bookId)}`);
export const updateAlbumMediaKind = (albumId: string, mediaKind: "music" | "book") =>
  sendJson<{ albumId: string; mediaKind: "music" | "book"; bookId: string | null }>(`/api/library/albums/${encodeURIComponent(albumId)}/media-kind`, {
    method: "PUT",
    body: JSON.stringify({ mediaKind })
  });
export const identifyAlbum = (albumId: string, payload?: AlbumIdentifyRequest) =>
  sendJson<AlbumIdentifyResponse>(`/api/library/albums/${encodeURIComponent(albumId)}/identify`, {
    method: "POST",
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
export const updateAlbumTags = (albumId: string, payload: AlbumTagsPayload) =>
  sendJson<{ albumId: string; detail: AlbumDetailRecord }>(`/api/library/albums/${encodeURIComponent(albumId)}/tags`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
export const updateTrackTags = (trackId: string, payload: TrackTagsPayload) =>
  sendJson<{ track: TrackRecord }>(`/api/library/tracks/${encodeURIComponent(trackId)}/tags`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
export const fetchRecentlyPlayed = () => getJson<TrackRecord[]>("/api/library/recently-played");
export const fetchLikedTrackIds = () => getJson<{ trackIds: string[] }>("/api/library/likes");
export const fetchPlaylists = () => getJson<PlaylistRecord[]>("/api/library/playlists");

export const requestRescan = async () => {
  return sendJson<{ accepted: boolean; queued?: boolean; message?: string }>("/api/library/rescan", {
    method: "POST"
  });
};

export const requestFolderRescan = (root: string) =>
  sendJson<{ accepted: boolean; root: string }>("/api/library/rescan-folder", {
    method: "POST",
    body: JSON.stringify({ root })
  });

export const recordTrackPlay = (trackId: string) =>
  sendJson<void>("/api/library/history", {
    method: "POST",
    body: JSON.stringify({ trackId })
  });

export const likeTrack = (trackId: string) =>
  sendJson<void>(`/api/library/likes/${encodeURIComponent(trackId)}`, {
    method: "POST"
  });

export const unlikeTrack = (trackId: string) =>
  sendJson<void>(`/api/library/likes/${encodeURIComponent(trackId)}`, {
    method: "DELETE"
  });

export const createPlaylist = (name: string) =>
  sendJson<{ id: string; name: string; createdAt: string }>("/api/library/playlists", {
    method: "POST",
    body: JSON.stringify({ name })
  });

export const addTrackToPlaylist = (playlistId: string, trackId: string) =>
  sendJson<void>(`/api/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "POST",
    body: JSON.stringify({ trackId })
  });

export const saveBookProgress = (
  bookId: string,
  payload: { trackId: string; positionSeconds: number },
  options?: { keepalive?: boolean }
) =>
  sendJson<{ progress: BookProgressRecord | null }>(`/api/library/books/${encodeURIComponent(bookId)}/progress`, {
    method: "PUT",
    keepalive: options?.keepalive,
    body: JSON.stringify(payload)
  });

export const createBookBookmark = (bookId: string, payload: { trackId: string; positionSeconds: number; label?: string }) =>
  sendJson<BookBookmarkRecord>(`/api/library/books/${encodeURIComponent(bookId)}/bookmarks`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const getCoverArtUrl = (coverArtId: string | null, cacheBuster?: string | number) =>
  coverArtId && getSessionToken()
    ? `/api/library/cover-art/${encodeURIComponent(coverArtId)}?token=${encodeURIComponent(getSessionToken() as string)}${cacheBuster === undefined ? "" : `&v=${encodeURIComponent(String(cacheBuster))}`}`
    : null;

export const getStreamUrl = (trackId: string) =>
  `/api/library/stream/${encodeURIComponent(trackId)}?token=${encodeURIComponent(getSessionToken() as string)}`;
