import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import type { AlbumSyncBundle, BookSyncBundle, PlaylistSyncBundle, SyncTrackRecord } from "@mp3-platform/shared";
import { getAbsoluteUrl } from "./api";

const OFFLINE_STORAGE_KEY = "mp3-platform-mobile-offline";
const MEDIA_DIRECTORY = `${FileSystem.documentDirectory ?? ""}media`;
const COVER_DIRECTORY = `${MEDIA_DIRECTORY}/covers`;
const TRACK_DIRECTORY = `${MEDIA_DIRECTORY}/tracks`;

const toSafePathSegment = (value: string) => encodeURIComponent(value);

export type OfflineTrackRecord = {
  id: string;
  localUri: string;
  title: string | null;
  artist: string | null;
  author: string | null;
  album: string | null;
  coverArtId: string | null;
  coverUri: string | null;
  bundleKeys: string[];
};

export type OfflineBundleRecord = {
  id: string;
  kind: "album" | "book" | "playlist";
  title: string;
  subtitle: string;
  trackIds: string[];
  coverUri: string | null;
  syncedAt: string;
};

export type OfflineLibraryState = {
  bundles: Record<string, OfflineBundleRecord>;
  tracks: Record<string, OfflineTrackRecord>;
};

export type OfflineSyncProgress = {
  completedTracks: number;
  totalTracks: number;
  fraction: number;
};

const emptyState = (): OfflineLibraryState => ({
  bundles: {},
  tracks: {}
});

const normalizeState = (raw: unknown): OfflineLibraryState => {
  if (!raw || typeof raw !== "object") {
    return emptyState();
  }

  const candidate = raw as {
    bundles?: Record<string, Partial<OfflineBundleRecord>>;
    tracks?: Record<string, Partial<OfflineTrackRecord> & { parentId?: string; parentKind?: "album" | "book" }>;
  };

  const bundles = Object.fromEntries(
    Object.entries(candidate.bundles ?? {}).map(([key, bundle]) => [
      key,
      {
        id: typeof bundle.id === "string" ? bundle.id : key.split(":").slice(1).join(":"),
        kind: bundle.kind === "album" || bundle.kind === "book" || bundle.kind === "playlist" ? bundle.kind : "album",
        title: typeof bundle.title === "string" ? bundle.title : "Offline bundle",
        subtitle: typeof bundle.subtitle === "string" ? bundle.subtitle : "",
        trackIds: Array.isArray(bundle.trackIds) ? bundle.trackIds.filter((trackId): trackId is string => typeof trackId === "string") : [],
        coverUri: typeof bundle.coverUri === "string" ? bundle.coverUri : null,
        syncedAt: typeof bundle.syncedAt === "string" ? bundle.syncedAt : new Date(0).toISOString()
      } satisfies OfflineBundleRecord
    ])
  );

  const tracks = Object.fromEntries(
    Object.entries(candidate.tracks ?? {}).flatMap(([trackId, track]) => {
      if (typeof track.localUri !== "string") {
        return [];
      }

      const derivedBundleKeys =
        Array.isArray(track.bundleKeys) && track.bundleKeys.every((bundleKey) => typeof bundleKey === "string")
          ? track.bundleKeys
          : Object.entries(bundles)
              .filter(([, bundle]) => bundle.trackIds.includes(trackId))
              .map(([bundleKey]) => bundleKey);
      const legacyBundleKey =
        derivedBundleKeys.length === 0 && typeof track.parentId === "string" && (track.parentKind === "album" || track.parentKind === "book")
          ? getBundleKey(track.parentKind, track.parentId)
          : null;

      return [[
        trackId,
        {
          id: trackId,
          localUri: track.localUri,
          title: typeof track.title === "string" ? track.title : null,
          artist: typeof track.artist === "string" ? track.artist : null,
          author: typeof track.author === "string" ? track.author : null,
          album: typeof track.album === "string" ? track.album : null,
          coverArtId: typeof track.coverArtId === "string" ? track.coverArtId : null,
          coverUri: typeof track.coverUri === "string" ? track.coverUri : null,
          bundleKeys: legacyBundleKey ? [legacyBundleKey] : derivedBundleKeys
        } satisfies OfflineTrackRecord
      ]];
    })
  );

  return { bundles, tracks };
};

const ensureDirectory = async (path: string) => {
  const info = await FileSystem.getInfoAsync(path);

  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
};

const getFileInfoSafe = async (path: string) => {
  try {
    return await FileSystem.getInfoAsync(path);
  } catch {
    return { exists: false, isDirectory: false, uri: path } as const;
  }
};

const persistState = async (state: OfflineLibraryState) => {
  await AsyncStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(state));
};

const downloadFile = async (
  remoteUri: string,
  localUri: string,
  token: string,
  onProgress?: (fraction: number) => void,
  forceRedownload = false
) => {
  const existing = await getFileInfoSafe(localUri);

  if (existing.exists && !forceRedownload) {
    onProgress?.(1);
    return localUri;
  }

  await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);

  const download = FileSystem.createDownloadResumable(
    remoteUri,
    localUri,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    (progress) => {
      if (!progress.totalBytesExpectedToWrite) {
        return;
      }

      onProgress?.(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
    }
  );

  await download.downloadAsync();
  onProgress?.(1);

  return localUri;
};

const getTrackExtension = (track: SyncTrackRecord) => {
  if (track.format === "m4b") {
    return "m4b";
  }

  if (track.format === "flac") {
    return "flac";
  }

  return "mp3";
};

const getBundleKey = (kind: OfflineBundleRecord["kind"], id: string) => `${kind}:${id}`;
const getMobileCoverArtUrl = (serverUrl: string, coverArtId: string) =>
  getAbsoluteUrl(serverUrl, `/api/library/cover-art/${encodeURIComponent(coverArtId)}?variant=mobile`);

const syncTrackList = async (
  state: OfflineLibraryState,
  serverUrl: string,
  token: string,
  bundleId: string,
  bundleKind: OfflineBundleRecord["kind"],
  tracks: SyncTrackRecord[],
  onProgress?: (progress: OfflineSyncProgress) => void
) => {
  await ensureDirectory(MEDIA_DIRECTORY);
  await ensureDirectory(COVER_DIRECTORY);
  await ensureDirectory(TRACK_DIRECTORY);

  const nextTracks: Record<string, OfflineTrackRecord> = {};
  const bundleKey = getBundleKey(bundleKind, bundleId);
  const totalTracks = tracks.length;
  let completedTracks = 0;
  let lastProgressPercent = -1;

  const emitProgress = (progress: OfflineSyncProgress) => {
    const nextPercent = Math.floor(progress.fraction * 100);
    if (nextPercent === lastProgressPercent && progress.fraction < 1) {
      return;
    }

    lastProgressPercent = nextPercent;
    onProgress?.(progress);
  };

  emitProgress({
    completedTracks,
    totalTracks,
    fraction: totalTracks === 0 ? 1 : 0
  });

  for (const track of tracks) {
    const trackPath = `${TRACK_DIRECTORY}/${toSafePathSegment(track.id)}.${getTrackExtension(track)}`;
    const localUri = await downloadFile(getAbsoluteUrl(serverUrl, track.downloadPath), trackPath, token, (trackFraction) => {
      emitProgress({
        completedTracks,
        totalTracks,
        fraction: totalTracks === 0 ? 1 : Math.min(1, (completedTracks + trackFraction) / totalTracks)
      });
    });

    let coverUri: string | null = null;

    if (track.coverArtId) {
      coverUri = `${COVER_DIRECTORY}/${toSafePathSegment(track.coverArtId)}.jpg`;
      coverUri = await downloadFile(
        getMobileCoverArtUrl(serverUrl, track.coverArtId),
        coverUri,
        token
      );
    }

    const existingTrack = state.tracks[track.id];
    const existingBundleKeys = existingTrack?.bundleKeys ?? [];

    nextTracks[track.id] = {
      id: track.id,
      localUri,
      title: track.title,
      artist: track.artist,
      author: track.author,
      album: track.album,
      coverArtId: track.coverArtId,
      coverUri,
      bundleKeys: existingBundleKeys.includes(bundleKey) ? existingBundleKeys : [...existingBundleKeys, bundleKey]
    };

    completedTracks += 1;
    emitProgress({
      completedTracks,
      totalTracks,
      fraction: totalTracks === 0 ? 1 : completedTracks / totalTracks
    });
  }

  return nextTracks;
};

export const loadOfflineLibrary = async (): Promise<OfflineLibraryState> => {
  const raw = await AsyncStorage.getItem(OFFLINE_STORAGE_KEY);

  if (!raw) {
    return emptyState();
  }

  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
};

export const syncAlbumOffline = async (
  state: OfflineLibraryState,
  serverUrl: string,
  token: string,
  bundle: AlbumSyncBundle,
  onProgress?: (progress: OfflineSyncProgress) => void
) => {
  const trackMap = await syncTrackList(state, serverUrl, token, bundle.album.id, "album", bundle.tracks, onProgress);
  const coverTrack = bundle.tracks.find((track) => trackMap[track.id]?.coverUri);
  const coverUri = coverTrack ? trackMap[coverTrack.id]?.coverUri ?? null : null;
  const nextState: OfflineLibraryState = {
    bundles: {
      ...state.bundles,
      [`album:${bundle.album.id}`]: {
        id: bundle.album.id,
        kind: "album",
        title: bundle.album.name,
        subtitle: bundle.album.artist,
        trackIds: bundle.tracks.map((track) => track.id),
        coverUri,
        syncedAt: new Date().toISOString()
      }
    },
    tracks: {
      ...state.tracks,
      ...trackMap
    }
  };

  await persistState(nextState);
  return nextState;
};

export const syncBookOffline = async (
  state: OfflineLibraryState,
  serverUrl: string,
  token: string,
  bundle: BookSyncBundle,
  onProgress?: (progress: OfflineSyncProgress) => void
) => {
  const trackMap = await syncTrackList(state, serverUrl, token, bundle.book.id, "book", bundle.tracks, onProgress);
  const coverTrack = bundle.tracks.find((track) => trackMap[track.id]?.coverUri);
  const coverUri = coverTrack ? trackMap[coverTrack.id]?.coverUri ?? null : null;
  const nextState: OfflineLibraryState = {
    bundles: {
      ...state.bundles,
      [`book:${bundle.book.id}`]: {
        id: bundle.book.id,
        kind: "book",
        title: bundle.book.title,
        subtitle: bundle.book.author,
        trackIds: bundle.tracks.map((track) => track.id),
        coverUri,
        syncedAt: new Date().toISOString()
      }
    },
    tracks: {
      ...state.tracks,
      ...trackMap
    }
  };

  await persistState(nextState);
  return nextState;
};

export const syncPlaylistOffline = async (
  state: OfflineLibraryState,
  serverUrl: string,
  token: string,
  bundle: PlaylistSyncBundle,
  onProgress?: (progress: OfflineSyncProgress) => void
) => {
  const trackMap = await syncTrackList(state, serverUrl, token, bundle.playlist.id, "playlist", bundle.tracks, onProgress);
  const coverTrack = bundle.tracks.find((track) => trackMap[track.id]?.coverUri);
  const coverUri = coverTrack ? trackMap[coverTrack.id]?.coverUri ?? null : null;
  const nextState: OfflineLibraryState = {
    bundles: {
      ...state.bundles,
      [`playlist:${bundle.playlist.id}`]: {
        id: bundle.playlist.id,
        kind: "playlist",
        title: bundle.playlist.name,
        subtitle: `${bundle.playlist.trackCount} tracks`,
        trackIds: bundle.tracks.map((track) => track.id),
        coverUri,
        syncedAt: new Date().toISOString()
      }
    },
    tracks: {
      ...state.tracks,
      ...trackMap
    }
  };

  await persistState(nextState);
  return nextState;
};

export const refreshOfflineCoverArt = async (
  state: OfflineLibraryState,
  serverUrl: string,
  token: string
) => {
  await ensureDirectory(MEDIA_DIRECTORY);
  await ensureDirectory(COVER_DIRECTORY);

  const nextTracks: Record<string, OfflineTrackRecord> = { ...state.tracks };
  const refreshedCoverUris = new Map<string, string>();

  for (const track of Object.values(state.tracks)) {
    if (!track.coverArtId) {
      continue;
    }

    let refreshedCoverUri = refreshedCoverUris.get(track.coverArtId) ?? null;

    if (!refreshedCoverUri) {
      const localCoverUri = `${COVER_DIRECTORY}/${toSafePathSegment(track.coverArtId)}.jpg`;
      refreshedCoverUri = await downloadFile(
        getMobileCoverArtUrl(serverUrl, track.coverArtId),
        localCoverUri,
        token,
        undefined,
        true
      );
      refreshedCoverUris.set(track.coverArtId, refreshedCoverUri);
    }

    nextTracks[track.id] = {
      ...track,
      coverUri: refreshedCoverUri
    };
  }

  const nextBundles = Object.fromEntries(
    Object.entries(state.bundles).map(([bundleKey, bundle]) => {
      const coverTrack = bundle.trackIds.find((trackId) => nextTracks[trackId]?.coverUri);

      return [
        bundleKey,
        {
          ...bundle,
          coverUri: coverTrack ? nextTracks[coverTrack]?.coverUri ?? null : null
        } satisfies OfflineBundleRecord
      ];
    })
  );

  const nextState: OfflineLibraryState = {
    bundles: nextBundles,
    tracks: nextTracks
  };

  await persistState(nextState);
  return nextState;
};

export const removeOfflineBundle = async (
  state: OfflineLibraryState,
  bundleKey: string
) => {
  const bundle = state.bundles[bundleKey];

  if (!bundle) {
    return state;
  }

  const nextTracks = { ...state.tracks };

  for (const trackId of bundle.trackIds) {
    const track = nextTracks[trackId];

    if (!track) {
      continue;
    }

    const remainingBundleKeys = track.bundleKeys.filter((key) => key !== bundleKey);

    if (remainingBundleKeys.length > 0) {
      nextTracks[trackId] = {
        ...track,
        bundleKeys: remainingBundleKeys
      };
      continue;
    }

    if (track?.localUri) {
      await FileSystem.deleteAsync(track.localUri, { idempotent: true });
    }

    delete nextTracks[trackId];
  }

  const nextBundles = { ...state.bundles };
  delete nextBundles[bundleKey];

  const nextState = {
    bundles: nextBundles,
    tracks: nextTracks
  };

  await persistState(nextState);
  return nextState;
};

export const getOfflineTrackUri = (state: OfflineLibraryState, trackId: string) => state.tracks[trackId]?.localUri ?? null;
export const getOfflineCoverUri = (state: OfflineLibraryState, trackId: string, fallbackCoverArtId?: string | null) =>
  state.tracks[trackId]?.coverUri ??
  (fallbackCoverArtId ? `${COVER_DIRECTORY}/${toSafePathSegment(fallbackCoverArtId)}.jpg` : null);
