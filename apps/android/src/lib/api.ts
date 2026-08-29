import type {
  AlbumDetailRecord,
  AlbumRecord,
  AlbumSyncBundle,
  AppBootstrap,
  BookDetailRecord,
  BookRecord,
  BookSyncBundle,
  LibrarySummary,
  PlaylistRecord,
  PlaylistSyncBundle,
  TrackRecord
} from "@mp3-platform/shared";
import { logError, logInfo } from "./logger";

export type SessionResponse = {
  user: {
    id: string;
    name: string;
    email: string;
    createdAt: string;
  };
  token: string;
};

type ApiOptions = {
  serverUrl: string;
  token: string | null;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
const LARGE_LIBRARY_REQUEST_TIMEOUT_MS = 15000;
const MEDIUM_LIBRARY_REQUEST_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  statusCode?: number;
  kind: "network" | "auth" | "http" | "invalid-response";

  constructor(message: string, kind: ApiError["kind"], statusCode?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export const isApiAuthError = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.kind === "auth";

export const isApiNetworkError = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.kind === "network";

const normalizeServerUrl = (value: string) => value.trim().replace(/\/+$/, "");

const summarizeRequest = (path: string, serverUrl: string, init?: RequestInit) => ({
  path,
  serverUrl: normalizeServerUrl(serverUrl),
  method: init?.method ?? "GET",
  hasAuthToken: Boolean(init?.headers && new Headers(init.headers).get("Authorization"))
});

const getRequestTimeoutMs = (path: string) => {
  if (path === "/api/library/tracks") {
    return LARGE_LIBRARY_REQUEST_TIMEOUT_MS;
  }

  if (
    path === "/api/library/albums" ||
    path === "/api/library/books" ||
    path === "/api/library/playlists" ||
    path === "/api/library/summary"
  ) {
    return MEDIUM_LIBRARY_REQUEST_TIMEOUT_MS;
  }

  return DEFAULT_REQUEST_TIMEOUT_MS;
};

const createRequestSignal = (timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) => {
  if (typeof AbortController === "undefined") {
    return {
      signal: undefined,
      clear: () => undefined,
      supportsAbortController: false
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
    supportsAbortController: true
  };
};

const buildHeaders = (token: string | null, extra?: HeadersInit) => {
  const headers = new Headers(extra);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
};

const isNetworkFailure = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error && /network request failed|failed to fetch|networkerror/i.test(error.message));

const isAbortError = (error: unknown) =>
  (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const describeNetworkFailure = (serverUrl: string) => {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const usesCleartextHttp = normalizedServerUrl.startsWith("http://");

  return usesCleartextHttp
    ? `Could not reach ${normalizedServerUrl}. Check that the server is running, this device can reach that IP address, and reinstall/update the Android app if it was built before local HTTP support was enabled.`
    : `Could not reach ${normalizedServerUrl}. Check that the server is running, the URL is correct, and this device is on the same network as the server.`;
};

export const probeServer = async (serverUrl: string) => {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const request = createRequestSignal();
  const startedAt = Date.now();

  try {
    const response = await fetch(`${normalizedServerUrl}/health`, { signal: request.signal });
    if (!response.ok) {
      throw new ApiError(
        response.status === 404
          ? `Connected to ${normalizedServerUrl}, but it does not look like an MP3 Platform server.`
          : `Connected to ${normalizedServerUrl}, but the server returned ${response.status} when checking its health endpoint.`,
        "http",
        response.status
      );
    }

    const body = await response.json().catch(() => null);
    if (!body || body.status !== "ok") {
      throw new ApiError(`Connected to ${normalizedServerUrl}, but the server returned an unexpected health response.`, "invalid-response");
    }

    await logInfo("Server probe succeeded", {
      serverUrl: normalizedServerUrl,
      durationMs: Date.now() - startedAt,
      supportsAbortController: request.supportsAbortController
    });
  } catch (error) {
    await logError("Server probe failed", error, {
      serverUrl: normalizedServerUrl,
      durationMs: Date.now() - startedAt,
      supportsAbortController: request.supportsAbortController
    });
    if (error instanceof ApiError) {
      throw error;
    }

    if (isAbortError(error)) {
      throw new ApiError(describeNetworkFailure(normalizedServerUrl), "network");
    }

    if (isNetworkFailure(error)) {
      throw new ApiError(describeNetworkFailure(normalizedServerUrl), "network");
    }

    throw error instanceof Error ? error : new Error("Server check failed");
  } finally {
    request.clear();
  }
};

const requestJson = async <T>(options: ApiOptions, path: string, init?: RequestInit) => {
  const requestUrl = `${normalizeServerUrl(options.serverUrl)}${path}`;
  const timeoutMs = getRequestTimeoutMs(path);
  const request = createRequestSignal(timeoutMs);
  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(requestUrl, {
      ...init,
      headers: buildHeaders(options.token, init?.headers),
      signal: request.signal
    });
  } catch (error) {
    await logError("API request failed before response", error, {
      ...summarizeRequest(path, options.serverUrl, init),
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      supportsAbortController: request.supportsAbortController
    });
    if (isAbortError(error)) {
      throw new ApiError(describeNetworkFailure(options.serverUrl), "network");
    }

    if (isNetworkFailure(error)) {
      throw new ApiError(describeNetworkFailure(options.serverUrl), "network");
    }

    throw error instanceof Error ? error : new Error(`Request failed for ${path}`);
  } finally {
    request.clear();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    await logInfo("API request returned non-OK response", {
      ...summarizeRequest(path, options.serverUrl, init),
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      statusCode: response.status,
      responseMessage: body?.message ?? null
    });
    if (response.status === 401) {
      throw new ApiError(body?.message ?? "Invalid email or password", "auth", response.status);
    }

    if (response.status === 404) {
      throw new ApiError(`Connected to ${normalizeServerUrl(options.serverUrl)}, but ${path} was not found. Check that you are using the correct server URL.`, "http", response.status);
    }

    throw new ApiError(body?.message ?? `Request failed for ${path}`, "http", response.status);
  }

  if (response.status === 204) {
    await logInfo("API request completed", {
      ...summarizeRequest(path, options.serverUrl, init),
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      statusCode: response.status
    });
    return undefined as T;
  }

  try {
    const payload = await response.json() as T;
    await logInfo("API request completed", {
      ...summarizeRequest(path, options.serverUrl, init),
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      statusCode: response.status
    });
    return payload;
  } catch (error) {
    await logError("API response JSON parse failed", error, {
      ...summarizeRequest(path, options.serverUrl, init),
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      statusCode: response.status
    });
    throw new ApiError(`Connected to ${normalizeServerUrl(options.serverUrl)}, but the server returned invalid JSON for ${path}.`, "invalid-response");
  }
};

export const getAbsoluteUrl = (serverUrl: string, path: string) => `${normalizeServerUrl(serverUrl)}${path}`;

export const loginUser = (serverUrl: string, payload: { email: string; password: string }) =>
  requestJson<SessionResponse>({ serverUrl, token: null }, "/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

export const registerFirstUser = (serverUrl: string, payload: { name: string; email: string; password: string }) =>
  requestJson<SessionResponse>({ serverUrl, token: null }, "/api/auth/register-first", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

export const fetchBootstrap = (options: ApiOptions) => requestJson<AppBootstrap>(options, "/api/app/bootstrap");
export const fetchLibrarySummary = (options: ApiOptions) => requestJson<LibrarySummary>(options, "/api/library/summary");
export const fetchAlbums = (options: ApiOptions) => requestJson<AlbumRecord[]>(options, "/api/library/albums");
export const fetchBooks = (options: ApiOptions) => requestJson<BookRecord[]>(options, "/api/library/books");
export const fetchPlaylists = (options: ApiOptions) => requestJson<PlaylistRecord[]>(options, "/api/library/playlists");
export const fetchTracks = (options: ApiOptions) => requestJson<TrackRecord[]>(options, "/api/library/tracks");
export const fetchLikedTrackIds = (options: ApiOptions) => requestJson<{ trackIds: string[] }>(options, "/api/library/likes");
export const fetchAlbumDetail = (options: ApiOptions, albumId: string) =>
  requestJson<AlbumDetailRecord>(options, `/api/library/albums/${encodeURIComponent(albumId)}`);
export const fetchBookDetail = (options: ApiOptions, bookId: string) =>
  requestJson<BookDetailRecord>(options, `/api/library/books/${encodeURIComponent(bookId)}`);
export const fetchAlbumSyncBundle = (options: ApiOptions, albumId: string) =>
  requestJson<AlbumSyncBundle>(options, `/api/library/albums/${encodeURIComponent(albumId)}/sync`);
export const fetchBookSyncBundle = (options: ApiOptions, bookId: string) =>
  requestJson<BookSyncBundle>(options, `/api/library/books/${encodeURIComponent(bookId)}/sync`);
export const fetchPlaylistSyncBundle = (options: ApiOptions, playlistId: string) =>
  requestJson<PlaylistSyncBundle>(options, `/api/library/playlists/${encodeURIComponent(playlistId)}/sync`);

export const saveBookProgress = (
  options: ApiOptions,
  bookId: string,
  payload: { trackId: string; positionSeconds: number }
) =>
  requestJson<{ progress: { trackId: string; positionSeconds: number; updatedAt: string } | null }>(
    options,
    `/api/library/books/${encodeURIComponent(bookId)}/progress`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

export const likeTrack = (options: ApiOptions, trackId: string) =>
  requestJson<void>(options, `/api/library/likes/${encodeURIComponent(trackId)}`, {
    method: "POST"
  });

export const unlikeTrack = (options: ApiOptions, trackId: string) =>
  requestJson<void>(options, `/api/library/likes/${encodeURIComponent(trackId)}`, {
    method: "DELETE"
  });

export const createPlaylist = (options: ApiOptions, name: string) =>
  requestJson<{ id: string; name: string; createdAt: string }>(options, "/api/library/playlists", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });

export const addTrackToPlaylist = (options: ApiOptions, playlistId: string, trackId: string) =>
  requestJson<void>(options, `/api/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ trackId })
  });
