import { Component, memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  Image,
  Linking,
  NativeModules,
  PanResponder,
  PermissionsAndroid,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import {
  createAudioPlayer,
  getTrackPlayerDiagnosticsSnapshot,
  setAudioModeAsync,
  setTrackPlayerServiceHandlers,
  type AudioPlayer,
  type AudioStatus
} from "./src/lib/trackPlayerAdapter";
import {
  ArrowRight,
  BookmarkCheck,
  CircleCheck,
  BookOpen,
  CircleAlert,
  Clock3,
  CloudCheck,
  CloudDownload,
  Copy,
  Disc3,
  Download,
  EllipsisVertical,
  Heart,
  Hourglass,
  House,
  Headphones,
  LibraryBig,
  ListEnd,
  ListMusic,
  ListStart,
  LoaderCircle,
  Menu as MenuIcon,
  Pause,
  Play,
  RotateCcw,
  RedoDot,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  UndoDot,
  Users,
  GripVertical
} from "lucide-react-native";
import type { AlbumDetailRecord, AlbumRecord, BookDetailRecord, BookRecord, PlaylistRecord, TrackRecord } from "@mp3-platform/shared";
import {
  fetchAlbumDetail,
  addTrackToPlaylist,
  createPlaylist,
  fetchAlbumSyncBundle,
  fetchAlbums,
  fetchBookDetail,
  fetchBookSyncBundle,
  fetchBooks,
  fetchBootstrap,
  fetchLikedTrackIds,
  fetchLibrarySummary,
  fetchPlaylists,
  fetchPlaylistSyncBundle,
  fetchTracks,
  getAbsoluteUrl,
  isApiAuthError,
  isApiNetworkError,
  likeTrack,
  loginUser,
  probeServer,
  registerFirstUser,
  saveBookProgress,
  unlikeTrack
} from "./src/lib/api";
import {
  getOfflineCoverUri,
  getOfflineTrackUri,
  loadOfflineLibrary,
  refreshOfflineCoverArt,
  removeOfflineBundle,
  syncAlbumOffline,
  syncBookOffline,
  syncPlaylistOffline,
  type OfflineSyncProgress,
  type OfflineLibraryState
} from "./src/lib/offline";
import { APP_LOG_FILE_PATH, NATIVE_APP_LOG_FILE_PATH, clearAppLog, logError, logInfo, readAppLog, setAppLogSessionContext, setAppLoggingEnabled } from "./src/lib/logger";
import { theme } from "./src/theme";

type ViewName = "home" | "library" | "search" | "downloads" | "liked" | "settings";
type LibraryMode = "albums" | "artists" | "books" | "playlists";
type AuthMode = "login" | "register";
type QueueSource = "album" | "book" | "playlist" | "search";
type SyncKind = "album" | "book" | "playlist";
type CurrentItem =
  | { type: "album"; id: string }
  | { type: "artist"; id: string }
  | { type: "book"; id: string }
  | { type: "playlist"; id: string }
  | null;

type QueueEntry = {
  track: TrackRecord;
  source: QueueSource;
  sourceId: string | null;
};

type PendingQueueAdvance = {
  index: number;
  queue: QueueEntry[];
  finishedTrackId: string;
  requestedAt: number;
};

type NativeQueueAudioSource = {
  uri?: string;
  headers?: Record<string, string>;
  title?: string;
  artist?: string;
  albumTitle?: string;
  artworkUrl?: string | null;
  duration?: number;
};

type NativeQueueAudioPlayer = AudioPlayer & {
  replaceQueue?: (
    sources: NativeQueueAudioSource[],
    startIndex: number,
    startPositionSeconds?: number,
    playWhenReady?: boolean
  ) => void;
  seekToQueueItem?: (index: number, startPositionSeconds?: number, playWhenReady?: boolean) => void;
};

type NativeQueueAudioStatus = AudioStatus & {
  currentMediaItemIndex?: number;
  currentMediaItemCount?: number;
};

type SyncRequest = {
  kind: SyncKind;
  id: string;
};

type NavigationSnapshot = {
  view: ViewName;
  libraryMode: LibraryMode;
  currentItem: CurrentItem;
};

type SyncVisualState = "idle" | "queued" | "syncing" | "synced" | "error";
type NavIcon = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type LibraryCardItem = {
  key: string;
  title: string;
  subtitle: string;
  accent: string | null;
  icon?: ReactNode;
  artBadge?: ReactNode;
  artBadgeAlign?: "left" | "right";
  artCornerIcon?: ReactNode;
  artCornerIconAlign?: "left" | "right";
  remoteUri: string | null;
  offlineUri: string | null;
  onPress: () => void;
};

const SERVER_URL_KEY = "mp3-platform-mobile-server-url";
const SESSION_TOKEN_KEY = "mp3-platform-mobile-session-token";
const SEARCH_HISTORY_KEY = "mp3-platform-mobile-search-history";
const LIBRARY_CACHE_KEY = "mp3-platform-mobile-library-cache";
const DIAGNOSTICS_EXPORT_DIRECTORY_URI_KEY = "mp3-platform-mobile-diagnostics-export-directory-uri";
const BOOK_PROGRESS_CACHE_KEY = "mp3-platform-mobile-book-progress";
const KEEP_AWAKE_WHILE_PLAYING_KEY = "mp3-platform-mobile-keep-awake-while-playing";
const APP_LOGGING_ENABLED_KEY = "mp3-platform-mobile-logging-enabled";
const LAST_LISTENED_ENTITY_KEY = "mp3-platform-mobile-last-listened-entity";

type PersistedLibraryCache = {
  albums: AlbumRecord[];
  books: BookRecord[];
  playlists: PlaylistRecord[];
  tracks: TrackRecord[];
  likedTrackIds: string[];
  summaryText: string;
};

type PersistedBookProgressEntry = {
  trackId: string;
  positionSeconds: number;
  updatedAt: string;
};

const getBookTrackAuthor = (track: Pick<TrackRecord, "bookId" | "artist" | "author">) =>
  track.bookId ? track.artist ?? track.author ?? null : track.author ?? track.artist ?? null;

const getBookNarrator = (track: Pick<TrackRecord, "bookId" | "albumArtist" | "artist">) =>
  track.bookId ? track.albumArtist ?? null : null;

type PersistedLastListenedEntity = {
  kind: "album" | "book" | "playlist";
  id: string;
  updatedAt: string;
};

type PlaylistPickerState = {
  track: TrackRecord;
  creating: boolean;
  title: string;
  busy: boolean;
  error: string | null;
};

type MobilePlaylistRecord = PlaylistRecord;

const isSmartPlaylistRecord = (playlist: Pick<MobilePlaylistRecord, "id" | "isSmart"> | null | undefined) =>
  Boolean(playlist?.isSmart || playlist?.id.startsWith("smart:"));

const getPlaylistDisplaySubtitle = (playlist: Pick<MobilePlaylistRecord, "description" | "trackCount">) =>
  playlist.description ?? `${playlist.trackCount} tracks`;

const navigationItems: Array<{ id: ViewName; icon: NavIcon; label: string }> = [
  { id: "home", icon: House, label: "Home" },
  { id: "library", icon: BookOpen, label: "Library" },
  { id: "search", icon: Search, label: "Search" }
];

const mobileMenuActions: Array<{ key: string; icon: NavIcon; label: string; action: "view" | "albums" | "artists" | "books" | "playlists" | "downloads" | "liked" | "settings" }> = [
  { key: "home", icon: House, label: "Home", action: "view" },
  { key: "albums", icon: Disc3, label: "Albums", action: "albums" },
  { key: "artists", icon: Users, label: "Artists", action: "artists" },
  { key: "books", icon: BookOpen, label: "Books", action: "books" },
  { key: "playlists", icon: LibraryBig, label: "Playlists", action: "playlists" },
  { key: "liked", icon: Heart, label: "Liked Songs", action: "liked" },
  { key: "downloads", icon: Download, label: "Downloads", action: "downloads" },
  { key: "settings", icon: Settings, label: "Settings", action: "settings" }
];

const resolveNavIcon = (icon: NavIcon | undefined): NavIcon => (icon ?? House);
const safeMap = <T, U>(items: T[] | null | undefined, mapper: (item: T, index: number) => U, label: string): U[] => {
  if (!Array.isArray(items)) {
    void logError("Render map received a non-array value", null, {
      label,
      valueType: typeof items
    });
    return [];
  }

  const nextItems: U[] = [];

  for (let index = 0; index < items.length; index += 1) {
    try {
      nextItems.push(mapper(items[index] as T, index));
    } catch (error) {
      void logError("Render map callback failed", error, {
        label,
        itemCount: items.length,
        itemIndex: index
      });
    }
  }

  return nextItems;
};

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const formatTrackTime = (seconds: number | null | undefined) => {
  if (!seconds || !Number.isFinite(seconds)) {
    return "--:--";
  }

  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

const formatHourMinuteDuration = (seconds: number | null | undefined) => {
  if (!seconds || !Number.isFinite(seconds)) {
    return "--h --m";
  }

  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

const truncateTrackLabel = (value: string, maxLength = 30) => (value.length > maxLength ? `${value.slice(0, maxLength)}...` : value);
const truncateQueueLabel = (value: string, maxLength = 25) => (value.length > maxLength ? `${value.slice(0, maxLength)}...` : value);
const hasMeaningfulBookProgress = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!progress || !Array.isArray(tracks) || tracks.length === 0) {
    return false;
  }

  const orderedTracks = sortTracksByOrder(tracks);
  const firstTrackId = orderedTracks[0]?.id ?? null;
  return progress.positionSeconds > 0 || (firstTrackId !== null && progress.trackId !== firstTrackId);
};

const buildBookProgressStatusLabel = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!progress) {
    return null;
  }

  const matchingTrack = tracks?.find((track) => track.id === progress.trackId) ?? null;
  const chapterLabel = matchingTrack?.title ? ` in ${matchingTrack.title}` : "";
  return `Synced bookmark at ${formatTrackTime(progress.positionSeconds)}${chapterLabel}`;
};
const getBookDurationSeconds = (tracks: TrackRecord[] | null | undefined) =>
  Array.isArray(tracks)
    ? tracks.reduce((total, track) => total + Math.max(0, track.durationSeconds ?? 0), 0)
    : 0;

const mergeBooksWithLocalProgress = (
  books: BookRecord[],
  persistedProgress: Record<string, PersistedBookProgressEntry>
) =>
  books.map((book) => {
    const localProgress = persistedProgress[book.id];

    if (!localProgress) {
      return book;
    }

    const serverUpdatedAt = book.lastListenedAt ?? "";
    if (serverUpdatedAt && serverUpdatedAt >= localProgress.updatedAt) {
      return book;
    }

    return {
      ...book,
      lastTrackId: localProgress.trackId,
      lastPositionSeconds: localProgress.positionSeconds,
      lastListenedAt: localProgress.updatedAt
    };
  });

const deriveBooksFromTracks = (tracks: TrackRecord[]) => {
  const byBook = new Map<string, BookRecord>();

  for (const track of tracks) {
    if (track.mediaKind !== "book" || !track.bookId) {
      continue;
    }

    const existing = byBook.get(track.bookId);
    if (existing) {
      existing.trackCount += 1;
      existing.durationSeconds += Math.max(0, track.durationSeconds ?? 0);
      if (!existing.coverArtId && track.coverArtId) {
        existing.coverArtId = track.coverArtId;
      }
      continue;
    }

    byBook.set(track.bookId, {
      id: track.bookId,
      title: track.bookTitle ?? track.album ?? track.title ?? "Unknown Book",
      author: getBookTrackAuthor(track) ?? "Unknown Author",
      trackCount: 1,
      durationSeconds: Math.max(0, track.durationSeconds ?? 0),
      coverArtId: track.coverArtId ?? null,
      lastListenedAt: null,
      lastTrackId: null,
      lastPositionSeconds: null
    });
  }

  return [...byBook.values()].sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: "base" }));
};

const isSuspiciousEmptyLibraryResponse = (params: {
  nextAlbums: AlbumRecord[] | null;
  nextBooks: BookRecord[] | null;
  nextPlaylists: PlaylistRecord[] | null;
  nextTracks: TrackRecord[] | null;
  currentAlbumsCount: number;
  currentBooksCount: number;
  currentPlaylistsCount: number;
  currentTracksCount: number;
  offlineBundleCount: number;
}) => {
  const {
    nextAlbums,
    nextBooks,
    nextPlaylists,
    nextTracks,
    currentAlbumsCount,
    currentBooksCount,
    currentPlaylistsCount,
    currentTracksCount,
    offlineBundleCount
  } = params;

  if (!nextAlbums || !nextBooks || !nextPlaylists || !nextTracks) {
    return false;
  }

  const nextLibraryLooksEmpty = nextAlbums.length === 0 && nextBooks.length === 0 && nextTracks.length === 0;
  const currentLibraryHasContent =
    currentAlbumsCount > 0 || currentBooksCount > 0 || currentPlaylistsCount > 1 || currentTracksCount > 0 || offlineBundleCount > 0;

  return nextLibraryLooksEmpty && currentLibraryHasContent;
};

const shouldPreserveExistingBooks = (params: {
  resolvedBooks: BookRecord[] | null;
  nextAlbums: AlbumRecord[] | null;
  nextTracks: TrackRecord[] | null;
  currentBooksCount: number;
}) => {
  const { resolvedBooks, nextAlbums, nextTracks, currentBooksCount } = params;

  if (!resolvedBooks || currentBooksCount === 0) {
    return false;
  }

  const booksDroppedOut = resolvedBooks.length === 0;
  const otherLibraryDataStillPresent = (nextAlbums?.length ?? 0) > 0 || (nextTracks?.length ?? 0) > 0;

  return booksDroppedOut && otherLibraryDataStillPresent;
};

const isBookCompleted = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!progress || !Array.isArray(tracks) || tracks.length === 0) {
    return false;
  }

  const orderedTracks = sortTracksByOrder(tracks);
  const totalDurationSeconds = getBookDurationSeconds(orderedTracks);
  if (totalDurationSeconds <= 0) {
    return false;
  }

  const completedTrackIndex = orderedTracks.findIndex((track) => track.id === progress.trackId);
  if (completedTrackIndex < 0) {
    return false;
  }

  const secondsBeforeCurrentTrack = orderedTracks
    .slice(0, completedTrackIndex)
    .reduce((total, track) => total + Math.max(0, track.durationSeconds ?? 0), 0);
  const absolutePositionSeconds = secondsBeforeCurrentTrack + Math.max(0, progress.positionSeconds);

  return absolutePositionSeconds >= Math.max(0, totalDurationSeconds - 600);
};

const isBookInProgress = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!progress || !Array.isArray(tracks) || tracks.length === 0) {
    return false;
  }

  const orderedTracks = sortTracksByOrder(tracks);
  const currentTrackIndex = orderedTracks.findIndex((track) => track.id === progress.trackId);
  if (currentTrackIndex < 0) {
    return false;
  }

  const secondsBeforeCurrentTrack = orderedTracks
    .slice(0, currentTrackIndex)
    .reduce((total, track) => total + Math.max(0, track.durationSeconds ?? 0), 0);
  const absolutePositionSeconds = secondsBeforeCurrentTrack + Math.max(0, progress.positionSeconds);

  return absolutePositionSeconds > 300 && !isBookCompleted(progress, orderedTracks);
};
const PLAYER_KEEP_AWAKE_TAG = "mp3-platform-player";
const LOCK_SCREEN_ARTWORK_DIRECTORY = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""}lockscreen-artwork`;
const PLAYBACK_CACHE_DIRECTORY = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""}playback-cache`;
const PLAYBACK_CACHE_MAX_TRACK_DURATION_SECONDS = 60 * 20;
const CLIPBOARD_COPY_MAX_CHARACTERS = 180_000;
const DIAGNOSTICS_PREVIEW_MAX_CHARACTERS = 24_000;

const formatDiagnosticsPreview = (value: string | null | undefined) => {
  const rawText = value?.length ? value : "No log entries yet.";

  if (rawText.length <= DIAGNOSTICS_PREVIEW_MAX_CHARACTERS) {
    return rawText;
  }

  return `[Showing the most recent ${DIAGNOSTICS_PREVIEW_MAX_CHARACTERS.toLocaleString()} characters of this log. Use Save to Downloads, Open Saved File, or Share Log for the full contents.]\n\n${rawText.slice(
    rawText.length - DIAGNOSTICS_PREVIEW_MAX_CHARACTERS
  )}`;
};

const getPlaybackCacheUri = (track: TrackRecord) => `${PLAYBACK_CACHE_DIRECTORY}/${encodeURIComponent(track.id)}.${track.format || "mp3"}`;
const shouldCacheTrackForPlayback = (track: TrackRecord) =>
  track.mediaKind === "music" && (track.durationSeconds ?? 0) > 0 && (track.durationSeconds ?? 0) <= PLAYBACK_CACHE_MAX_TRACK_DURATION_SECONDS;
const getUriScheme = (uri: string | null | undefined) => {
  if (!uri) {
    return "none";
  }

  const match = uri.match(/^([a-z0-9+.-]+):/i);
  return match?.[1]?.toLowerCase() ?? "unknown";
};

const sortTracksByOrder = (tracks: TrackRecord[]) =>
  [...tracks].sort((left, right) => {
    const discDifference = (left.discNumber ?? 0) - (right.discNumber ?? 0);

    if (discDifference !== 0) {
      return discDifference;
    }

    return (left.trackNumber ?? 0) - (right.trackNumber ?? 0);
  });

const getDiagnosticsBuildInfo = () => {
  const expoVersion = Constants.expoConfig?.version ?? "0.7.0";
  const runtimeVersion = Constants.expoRuntimeVersion ?? "unknown-runtime";
  const executionEnvironment = Constants.executionEnvironment ?? "unknown-environment";
  const androidVersionCode =
    typeof Constants.platform?.android?.versionCode === "number" ? String(Constants.platform.android.versionCode) : "unknown-vc";
  const updateId =
    (typeof Constants.manifest2 === "object" && Constants.manifest2 && "id" in Constants.manifest2 && typeof Constants.manifest2.id === "string"
      ? Constants.manifest2.id
      : null) ??
    (typeof Constants.easConfig?.projectId === "string" ? Constants.easConfig.projectId : null) ??
    "embedded";

  return {
    buildFingerprint: `groovy/${expoVersion} (${runtimeVersion}; vc:${androidVersionCode}; ${executionEnvironment}; ${updateId})`,
    appVersion: expoVersion,
    runtimeVersion,
    executionEnvironment,
    androidVersionCode,
    updateId,
    sessionId: Constants.sessionId ?? "unknown-session"
  };
};

const shuffleTracks = (tracks: TrackRecord[]) => {
  const nextTracks = [...tracks];

  for (let index = nextTracks.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextTracks[index], nextTracks[swapIndex]] = [nextTracks[swapIndex]!, nextTracks[index]!];
  }

  return nextTracks;
};

const AppBody = () => {
  const diagnosticsBuildInfo = useMemo(() => getDiagnosticsBuildInfo(), []);
  const buildFingerprint = diagnosticsBuildInfo.buildFingerprint;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isTablet = width >= 920;
  const isPhone = !isTablet;
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [bootstrapRequiresRegister, setBootstrapRequiresRegister] = useState(false);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [view, setView] = useState<ViewName>("home");
  const [libraryMode, setLibraryMode] = useState<LibraryMode>("albums");
  const [albums, setAlbums] = useState<AlbumRecord[]>([]);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [likedTrackIds, setLikedTrackIds] = useState<Set<string>>(new Set());
  const [albumDetail, setAlbumDetail] = useState<AlbumDetailRecord | null>(null);
  const [bookDetail, setBookDetail] = useState<BookDetailRecord | null>(null);
  const [bookServerProgress, setBookServerProgress] = useState<BookDetailRecord["progress"] | null>(null);
  const [currentItem, setCurrentItem] = useState<CurrentItem>(null);
  const [summaryText, setSummaryText] = useState("Your listening library");
  const [searchText, setSearchText] = useState("");
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [offlineLibrary, setOfflineLibrary] = useState<OfflineLibraryState>({ bundles: {}, tracks: {} });
  const [syncingKey, setSyncingKey] = useState<string | null>(null);
  const [syncQueue, setSyncQueue] = useState<SyncRequest[]>([]);
  const [syncProgress, setSyncProgress] = useState<Record<string, OfflineSyncProgress>>({});
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [featuredAlbumId, setFeaturedAlbumId] = useState<string | null>(null);
  const [featuredBookId, setFeaturedBookId] = useState<string | null>(null);
  const [featuredPlaylistId, setFeaturedPlaylistId] = useState<string | null>(null);
  const [featuredArtistId, setFeaturedArtistId] = useState<string | null>(null);
  const [lastListenedEntity, setLastListenedEntity] = useState<PersistedLastListenedEntity | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobilePlayerExpanded, setMobilePlayerExpanded] = useState(false);
  const [diagnosticsLog, setDiagnosticsLog] = useState("");
  const [lockScreenDiagnostics, setLockScreenDiagnostics] = useState("");
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsExportNotice, setDiagnosticsExportNotice] = useState<string | null>(null);
  const [lastDiagnosticsExportUri, setLastDiagnosticsExportUri] = useState<string | null>(null);
  const [lastDiagnosticsExportDirectoryUri, setLastDiagnosticsExportDirectoryUri] = useState<string | null>(null);
  const [keepAwakeWhilePlaying, setKeepAwakeWhilePlaying] = useState(false);
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [startupHydrated, setStartupHydrated] = useState(false);
  const [coverArtRefreshKey, setCoverArtRefreshKey] = useState<string>("startup");
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [playlistPickerState, setPlaylistPickerState] = useState<PlaylistPickerState | null>(null);
  const [pendingQueueAdvance, setPendingQueueAdvance] = useState<PendingQueueAdvance | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const playerSubscriptionRef = useRef<{ remove: () => void } | null>(null);
  const queueRef = useRef<QueueEntry[]>([]);
  const currentIndexRef = useRef(-1);
  const offlineLibraryRef = useRef<OfflineLibraryState>({ bundles: {}, tracks: {} });
  const refreshedPlaylistSyncsRef = useRef<Set<string>>(new Set());
  const navigationHistoryRef = useRef<NavigationSnapshot[]>([]);
  const restoringNavigationRef = useRef(false);
  const lastHandledFinishRef = useRef<{ trackId: string; index: number; at: number } | null>(null);
  const queueAdvanceInFlightRef = useRef<{ trackId: string; index: number } | null>(null);
  const lastPlaybackStatusSummaryRef = useRef<string | null>(null);
  const lastAdvanceAttemptRef = useRef<{ fromIndex: number; toIndex: number; at: number } | null>(null);
  const lastTrackStartRef = useRef<{ trackId: string; index: number; at: number } | null>(null);
  const lastLocalBookProgressSaveRef = useRef<{ bookId: string; checkpoint: number } | null>(null);
  const lastServerBookProgressSaveRef = useRef<{ bookId: string; checkpoint: number } | null>(null);
  const latestBookProgressRef = useRef<{ bookId: string; trackId: string; positionSeconds: number; updatedAt: string } | null>(null);
  const lastExplicitSeekRef = useRef<{ trackId: string; positionSeconds: number; at: number } | null>(null);
  const notificationPermissionRequestedRef = useRef(false);
  const playbackCacheDownloadsRef = useRef<Set<string>>(new Set());
  const statusNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaArtworkUriCacheRef = useRef<Record<string, string>>({});
  const lastBluetoothMetadataPushRef = useRef<{
    trackId: string;
    artworkUri: string | null;
    title: string | null;
    artist: string | null;
    albumTitle: string | null;
    at: string;
  } | null>(null);
  const nativeClipboardModuleRef = useRef<{ copyText?: (label: string, text: string) => Promise<void> } | null>(
    (NativeModules as { NativeClipboard?: { copyText?: (label: string, text: string) => Promise<void> } }).NativeClipboard ?? null
  );
  const nativeMediaBrowserModuleRef = useRef<{
    updateLibraryCache?: (cacheJson: string) => Promise<void>;
    updateNowPlaying?: (nowPlayingJson: string) => Promise<void>;
    clearNowPlaying?: () => Promise<void>;
    buildArtworkContentUri?: (fileUri: string) => Promise<string | null>;
  } | null>(
    (NativeModules as {
      GroovyMediaBrowser?: {
        updateLibraryCache?: (cacheJson: string) => Promise<void>;
        updateNowPlaying?: (nowPlayingJson: string) => Promise<void>;
        clearNowPlaying?: () => Promise<void>;
        buildArtworkContentUri?: (fileUri: string) => Promise<string | null>;
      };
    }).GroovyMediaBrowser ?? null
  );

  const apiOptions = useMemo(() => ({ serverUrl, token }), [serverUrl, token]);
  const diagnosticsPath = `${APP_LOG_FILE_PATH} + ${NATIVE_APP_LOG_FILE_PATH}`;
  const trimmedSearchText = searchText.trim();
  const normalizedServerUrl = serverUrl.trim();

  const getPlayerDebugSnapshot = () => {
    const player = playerRef.current as NativeQueueAudioPlayer | null;
    return {
      hasPlayer: Boolean(player),
      queueLength: queueRef.current.length,
      currentIndex: currentIndexRef.current,
      currentTrackId: queueRef.current[currentIndexRef.current]?.track.id ?? null,
      playerPlaying: player?.playing ?? null,
      playerCurrentTime: player?.currentTime ?? null,
      playerDuration: player?.duration ?? null,
      hasNativeReplaceQueue: typeof player?.replaceQueue === "function",
      hasNativeSeekToQueueItem: typeof player?.seekToQueueItem === "function"
    };
  };

  const logPlayerDebugSnapshot = (message: string, details?: Record<string, unknown>) => {
    void logInfo(message, {
      ...getPlayerDebugSnapshot(),
      ...(details ?? {})
    });
  };

  const syncNativeMediaBrowserLibraryCache = async (cache: PersistedLibraryCache) => {
    const browserModule = nativeMediaBrowserModuleRef.current;
    if (!browserModule?.updateLibraryCache) {
      return;
    }

    try {
      await logInfo("Syncing native media browser library cache", {
        albumCount: cache.albums.length,
        bookCount: cache.books.length,
        playlistCount: cache.playlists.length,
        trackCount: cache.tracks.length,
        firstAlbumHasCover: Boolean(cache.albums[0]?.coverArtId),
        firstBookHasCover: Boolean(cache.books[0]?.coverArtId),
        firstPlaylistHasCover: Boolean(cache.playlists[0]?.coverArtId)
      });
      await browserModule.updateLibraryCache(JSON.stringify(cache));
    } catch (error) {
      await logError("Native media browser library cache sync failed", error, {
        albumCount: cache.albums.length,
        bookCount: cache.books.length,
        playlistCount: cache.playlists.length,
        trackCount: cache.tracks.length
      });
    }
  };

  const syncNativeMediaBrowserNowPlaying = async (
    track: TrackRecord,
    metadata: { title?: string; artist?: string; albumTitle?: string; artworkUrl?: string | null },
    options?: { isPlaying?: boolean }
  ) => {
    const browserModule = nativeMediaBrowserModuleRef.current;
    if (!browserModule?.updateNowPlaying) {
      return;
    }

    try {
      await logInfo("Syncing native media browser now playing", {
        trackId: track.id,
        title: metadata.title ?? null,
        artist: metadata.artist ?? null,
        albumTitle: metadata.albumTitle ?? null,
        artworkUri: metadata.artworkUrl ?? null,
        artworkScheme: getUriScheme(metadata.artworkUrl),
        isPlaying: options?.isPlaying ?? isPlaying,
        currentIndex: currentIndexRef.current,
        queueLength: queueRef.current.length
      });
      await browserModule.updateNowPlaying(
        JSON.stringify({
          trackId: track.id,
          title: metadata.title ?? null,
          artist: metadata.artist ?? null,
          albumTitle: metadata.albumTitle ?? null,
          artworkUri: metadata.artworkUrl ?? null,
          isPlaying: options?.isPlaying ?? isPlaying,
          positionSeconds: playbackPosition,
          durationSeconds: playbackDuration || track.durationSeconds || 0,
          currentIndex: currentIndexRef.current,
          queueLength: queueRef.current.length,
          hasPrevious: currentIndexRef.current > 0,
          hasNext: currentIndexRef.current >= 0 && currentIndexRef.current < queueRef.current.length - 1
        })
      );
    } catch (error) {
      await logError("Native media browser now playing sync failed", error, {
        trackId: track.id
      });
    }
  };

  const clearNativeMediaBrowserNowPlaying = async () => {
    const browserModule = nativeMediaBrowserModuleRef.current;
    if (!browserModule?.clearNowPlaying) {
      return;
    }

    try {
      await logInfo("Clearing native media browser now playing");
      await browserModule.clearNowPlaying();
    } catch (error) {
      await logError("Native media browser now playing clear failed", error);
    }
  };

  const scheduleAdvanceDiagnostics = (stage: string, targetIndex: number, targetTrackId: string | null) => {
    [50, 250, 1000].forEach((delayMs) => {
      setTimeout(() => {
        logPlayerDebugSnapshot("Queue advance snapshot", {
          stage,
          delayMs,
          targetIndex,
          targetTrackId,
          inFlightAdvance: queueAdvanceInFlightRef.current,
          lastHandledFinish: lastHandledFinishRef.current,
          lastAdvanceAttempt: lastAdvanceAttemptRef.current
        });
      }, delayMs);
    });
  };

  const rememberBookProgress = (track: TrackRecord | null | undefined, positionSeconds: number, updatedAt = new Date().toISOString()) => {
    if (!track?.bookId || !Number.isFinite(positionSeconds) || positionSeconds < 0) {
      return;
    }

    latestBookProgressRef.current = {
      bookId: track.bookId,
      trackId: track.id,
      positionSeconds,
      updatedAt
    };
  };

  const getPersistableBookProgress = (track: TrackRecord | null | undefined) => {
    if (!track?.bookId) {
      return null;
    }

    const cachedProgress =
      latestBookProgressRef.current?.bookId === track.bookId && latestBookProgressRef.current.trackId === track.id
        ? latestBookProgressRef.current
        : null;
    const playerPosition =
      playerRef.current && Number.isFinite(playerRef.current.currentTime) ? Math.max(0, playerRef.current.currentTime) : null;
    const recentExplicitSeek =
      lastExplicitSeekRef.current?.trackId === track.id && Date.now() - lastExplicitSeekRef.current.at < 10000
        ? lastExplicitSeekRef.current
        : null;
    let resolvedPositionSeconds = cachedProgress?.positionSeconds ?? playbackPosition;

    if (recentExplicitSeek) {
      resolvedPositionSeconds = recentExplicitSeek.positionSeconds;
    } else if (playerPosition !== null) {
      if (playerPosition >= resolvedPositionSeconds || Math.abs(playerPosition - resolvedPositionSeconds) <= 8) {
        resolvedPositionSeconds = playerPosition;
      }
    }

    if (!Number.isFinite(resolvedPositionSeconds) || resolvedPositionSeconds <= 0) {
      return null;
    }

    const updatedAt = cachedProgress?.updatedAt ?? new Date().toISOString();
    rememberBookProgress(track, resolvedPositionSeconds, updatedAt);

    return {
      bookId: track.bookId,
      trackId: track.id,
      positionSeconds: resolvedPositionSeconds,
      updatedAt
    };
  };

  const readPersistedBookProgress = async () => {
    const raw = await AsyncStorage.getItem(BOOK_PROGRESS_CACHE_KEY);
    if (!raw) {
      return {} as Record<string, PersistedBookProgressEntry>;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, PersistedBookProgressEntry>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {} as Record<string, PersistedBookProgressEntry>;
    }
  };

  const persistLocalBookProgress = async (bookId: string, entry: PersistedBookProgressEntry) => {
    const nextProgress = await readPersistedBookProgress();
    nextProgress[bookId] = entry;
    await AsyncStorage.setItem(BOOK_PROGRESS_CACHE_KEY, JSON.stringify(nextProgress));
  };

  const reconcileBookProgressWithServer = async (
    serverBooks: BookRecord[],
    persistedProgress: Record<string, PersistedBookProgressEntry>,
    reason: string
  ) => {
    if (!serverUrl || !token || serverBooks.length === 0) {
      return;
    }

    const staleServerBooks = serverBooks
      .map((book) => ({
        book,
        localProgress: persistedProgress[book.id] ?? null
      }))
      .filter(
        (entry): entry is { book: BookRecord; localProgress: PersistedBookProgressEntry } =>
          Boolean(entry.localProgress) && (entry.book.lastListenedAt ?? "") < entry.localProgress.updatedAt
      );

    if (staleServerBooks.length === 0) {
      return;
    }

    await logInfo("Book progress reconciliation started", {
      reason,
      bookCount: staleServerBooks.length,
      bookIds: staleServerBooks.map((entry) => entry.book.id)
    });

    const results = await Promise.allSettled(
      staleServerBooks.map(async ({ book, localProgress }) => {
        const response = await saveBookProgress(
          {
            serverUrl,
            token
          },
          book.id,
          {
            trackId: localProgress.trackId,
            positionSeconds: localProgress.positionSeconds
          }
        );

        return {
          bookId: book.id,
          progress: response.progress ?? localProgress
        };
      })
    );

    const successful = results
      .filter((result): result is PromiseFulfilledResult<{ bookId: string; progress: PersistedBookProgressEntry }> => result.status === "fulfilled")
      .map((result) => result.value);
    const failed = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (successful.length > 0) {
      setBooks((previous) =>
        previous.map((book) => {
          const synced = successful.find((entry) => entry.bookId === book.id);
          return synced
            ? {
                ...book,
                lastTrackId: synced.progress.trackId,
                lastPositionSeconds: synced.progress.positionSeconds,
                lastListenedAt: synced.progress.updatedAt
              }
            : book;
        })
      );
    }

    await logInfo("Book progress reconciliation finished", {
      reason,
      attempted: staleServerBooks.length,
      successfulBookIds: successful.map((entry) => entry.bookId),
      failedBookIds: staleServerBooks
        .map((entry) => entry.book.id)
        .filter((bookId) => !successful.some((entry) => entry.bookId === bookId))
    });

    await Promise.all(
      failed.map((error, index) =>
        logError("Book progress reconciliation failed", error, {
          reason,
          bookId: staleServerBooks[index]?.book.id ?? null
        })
      )
    );
  };

  const readLastListenedEntity = async () => {
    const raw = await AsyncStorage.getItem(LAST_LISTENED_ENTITY_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedLastListenedEntity;
      if (!parsed || (parsed.kind !== "album" && parsed.kind !== "book" && parsed.kind !== "playlist") || typeof parsed.id !== "string") {
        return null;
      }

      return {
        kind: parsed.kind,
        id: parsed.id,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
      } satisfies PersistedLastListenedEntity;
    } catch {
      return null;
    }
  };

  const persistLastListenedEntity = async (entry: PersistedLastListenedEntity | null) => {
    setLastListenedEntity(entry);

    if (!entry) {
      await AsyncStorage.removeItem(LAST_LISTENED_ENTITY_KEY);
      return;
    }

    await AsyncStorage.setItem(LAST_LISTENED_ENTITY_KEY, JSON.stringify(entry));
  };

  const mergeBookProgress = <
    T extends {
      progress?: { trackId: string; positionSeconds: number; updatedAt?: string } | null;
    }
  >(
    detail: T,
    localProgress: PersistedBookProgressEntry | null
  ): T => {
    if (!localProgress) {
      return detail;
    }

    const serverProgress = detail.progress;
    if (!serverProgress) {
      return {
        ...detail,
        progress: localProgress
      };
    }

    const serverUpdatedAt = serverProgress.updatedAt ?? "";
    if (localProgress.updatedAt > serverUpdatedAt) {
      return {
        ...detail,
        progress: localProgress
      };
    }

    return detail;
  };

  const applyBookProgressToState = (bookId: string, progress: PersistedBookProgressEntry) => {
    setBookDetail((previous) =>
      previous && previous.book.id === bookId
        ? {
            ...previous,
            book: {
              ...previous.book,
              lastTrackId: progress.trackId,
              lastPositionSeconds: progress.positionSeconds,
              lastListenedAt: progress.updatedAt
            },
            progress: {
              bookId,
              trackId: progress.trackId,
              positionSeconds: progress.positionSeconds,
              updatedAt: progress.updatedAt
            }
          }
        : previous
    );
    setBooks((previous) =>
      previous.map((book) =>
        book.id === bookId
          ? {
              ...book,
              lastTrackId: progress.trackId,
              lastPositionSeconds: progress.positionSeconds,
              lastListenedAt: progress.updatedAt
            }
          : book
      )
    );
  };

  const ensureNotificationPermission = async () => {
    if (Platform.OS !== "android" || Number(Platform.Version) < 33) {
      return true;
    }

    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    const alreadyGranted = await PermissionsAndroid.check(permission);
    if (alreadyGranted) {
      return true;
    }

    if (notificationPermissionRequestedRef.current) {
      return false;
    }

    notificationPermissionRequestedRef.current = true;
    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  };

  const showStatusNotice = (message: string, details?: Record<string, unknown>) => {
    if (statusNoticeTimeoutRef.current) {
      clearTimeout(statusNoticeTimeoutRef.current);
    }

    setStatusNotice(message);
    void logInfo("Status notice shown", {
      message,
      ...(details ?? {})
    });
    statusNoticeTimeoutRef.current = setTimeout(() => {
      setStatusNotice(null);
      statusNoticeTimeoutRef.current = null;
    }, 3200);
  };

  const offlineAlbums = useMemo<AlbumRecord[]>(
    () =>
      safeMap(
        Object.values(offlineLibrary.bundles)
          .filter((bundle) => bundle.kind === "album")
          .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt)),
        (bundle) => ({
          id: bundle.id,
          artistId: bundle.subtitle || bundle.id,
          artist: bundle.subtitle || "Offline Artist",
          name: bundle.title,
          songCount: bundle.trackIds.length,
          durationSeconds: 0,
          coverArtId: null
        }),
        "offlineAlbums"
      ),
    [offlineLibrary.bundles]
  );

  const offlineBooks = useMemo<BookRecord[]>(
    () =>
      safeMap(
        Object.values(offlineLibrary.bundles)
          .filter((bundle) => bundle.kind === "book")
          .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt)),
        (bundle) => ({
          id: bundle.id,
          title: bundle.title,
          author: bundle.subtitle || "Offline Author",
          trackCount: bundle.trackIds.length,
          durationSeconds: 0,
          coverArtId: null,
          lastListenedAt: null,
          lastTrackId: null,
          lastPositionSeconds: null
        }),
        "offlineBooks"
      ),
    [offlineLibrary.bundles]
  );

  const offlinePlaylists = useMemo<MobilePlaylistRecord[]>(
    () =>
      safeMap(
        Object.values(offlineLibrary.bundles)
          .filter((bundle) => bundle.kind === "playlist")
          .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt)),
        (bundle) => ({
          id: bundle.id,
          name: bundle.title,
          createdAt: bundle.syncedAt,
          trackCount: bundle.trackIds.length,
          durationSeconds: 0,
          coverArtId: null,
          tracks: []
        }),
        "offlinePlaylists"
      ),
    [offlineLibrary.bundles]
  );

  const derivedTrackBooks = useMemo<BookRecord[]>(() => {
    if (books.length > 0) {
      return [];
    }

    return deriveBooksFromTracks(tracks);
  }, [books.length, tracks]);

  const visibleAlbums = albums.length > 0 ? albums : offlineAlbums;
  const visibleBooks = books.length > 0 ? books : derivedTrackBooks.length > 0 ? derivedTrackBooks : offlineBooks;

  const filteredAlbums = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return query.length === 0
      ? visibleAlbums
      : visibleAlbums.filter((album) => `${album.name} ${album.artist}`.toLowerCase().includes(query));
  }, [searchText, visibleAlbums]);

  const filteredBooks = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return query.length === 0
      ? visibleBooks
      : visibleBooks.filter((book) => `${book.title} ${book.author}`.toLowerCase().includes(query));
  }, [searchText, visibleBooks]);

  const allArtists = useMemo(() => {
    const artistMap = new Map<
      string,
      { id: string; name: string; albumCount: number; totalTracks: number; coverArtId: string | null; coverUri: string | null }
    >();

    for (const album of visibleAlbums) {
      const existing = artistMap.get(album.artist);
      if (existing) {
        existing.albumCount += 1;
        existing.totalTracks += album.songCount;
        if (!existing.coverArtId && album.coverArtId) {
          existing.coverArtId = album.coverArtId;
        }
        if (!existing.coverUri) {
          existing.coverUri = offlineLibrary.bundles[`album:${album.id}`]?.coverUri ?? null;
        }
        continue;
      }

      artistMap.set(album.artist, {
        id: album.artist,
        name: album.artist,
        albumCount: 1,
        totalTracks: album.songCount,
        coverArtId: album.coverArtId,
        coverUri: offlineLibrary.bundles[`album:${album.id}`]?.coverUri ?? null
      });
    }

    return [...artistMap.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [offlineLibrary.bundles, visibleAlbums]);

  const filteredArtists = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return allArtists.filter((artist) => query.length === 0 || artist.name.toLowerCase().includes(query));
  }, [allArtists, searchText]);
  const visiblePlaylists = playlists.length > 0 ? playlists : offlinePlaylists;
  const fallbackVisiblePlaylists = visiblePlaylists.length > 0 ? visiblePlaylists : offlinePlaylists;
  const filteredPlaylists = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return query.length === 0
      ? fallbackVisiblePlaylists
      : fallbackVisiblePlaylists.filter((playlist) => playlist.name.toLowerCase().includes(query));
  }, [fallbackVisiblePlaylists, searchText]);
  const filteredSmartPlaylists = useMemo(
    () => filteredPlaylists.filter((playlist) => isSmartPlaylistRecord(playlist)),
    [filteredPlaylists]
  );
  const filteredPersonalPlaylists = useMemo(
    () => filteredPlaylists.filter((playlist) => !isSmartPlaylistRecord(playlist)),
    [filteredPlaylists]
  );
  const editablePlaylists = useMemo(
    () => playlists.filter((playlist) => !isSmartPlaylistRecord(playlist)),
    [playlists]
  );

  const artistAlbums = useMemo(
    () => (currentItem?.type === "artist" ? visibleAlbums.filter((album) => album.artist === currentItem.id) : []),
    [currentItem, visibleAlbums]
  );
  const artistBooks = useMemo(
    () => (currentItem?.type === "artist" ? visibleBooks.filter((book) => book.author === currentItem.id) : []),
    [currentItem, visibleBooks]
  );
  const artistTracks = useMemo(
    () =>
      currentItem?.type === "artist"
        ? tracks.filter(
            (track) => getBookTrackAuthor(track) === currentItem.id || track.artist === currentItem.id || track.albumArtist === currentItem.id
          )
        : [],
    [currentItem, tracks]
  );

  const playlistDetail = useMemo(
    () => (currentItem?.type === "playlist" ? fallbackVisiblePlaylists.find((playlist) => playlist.id === currentItem.id) ?? null : null),
    [currentItem, fallbackVisiblePlaylists]
  );

  const buildOfflineTrackStub = (
    trackId: string,
    index: number,
    options: {
      mediaKind: "music" | "book";
      album?: AlbumRecord | null;
      book?: BookRecord | null;
    }
  ): TrackRecord => {
    const offlineTrack = offlineLibrary.tracks[trackId];

    return {
      id: trackId,
      filePath: offlineTrack?.localUri ?? "",
      format: "mp3",
      title:
        offlineTrack?.title ??
        (options.mediaKind === "book" ? `Offline chapter ${index + 1}` : `Offline track ${index + 1}`),
      mediaKind: options.mediaKind,
      bookId: options.book?.id ?? null,
      bookTitle: options.book?.title ?? null,
      author: offlineTrack?.author ?? options.book?.author ?? null,
      artist: offlineTrack?.artist ?? options.album?.artist ?? null,
      artistId: options.album?.artistId ?? options.book?.author ?? "",
      album: offlineTrack?.album ?? options.album?.name ?? null,
      albumId: options.album?.id ?? "",
      albumArtist: options.album?.artist ?? null,
      albumArtistId: options.album?.artistId ?? "",
      genre: null,
      year: null,
      discNumber: 1,
      trackNumber: index + 1,
      durationSeconds: null,
      bitrate: null,
      sampleRate: null,
      modifiedAt: "",
      sizeBytes: 0,
      coverArtId: null
    };
  };

  const buildOfflineAlbumDetail = (albumId: string): AlbumDetailRecord | null => {
    const album = visibleAlbums.find((item) => item.id === albumId) ?? null;
    const bundle = offlineLibrary.bundles[`album:${albumId}`];

    if (!album || !bundle) {
      return null;
    }

    const offlineTracks = bundle.trackIds.map(
      (trackId, index) =>
        tracks.find((track) => track.id === trackId && track.albumId === albumId) ??
        buildOfflineTrackStub(trackId, index, { mediaKind: "music", album })
    );

    return {
      album,
      tracks: offlineTracks,
      year: null,
      genre: null,
      review: null,
      outline: "Showing synced album content while the server is unavailable.",
      artistBiography: null,
      artistOutline: null,
      artistFolderTitle: null
    };
  };

  const buildOfflineBookDetail = (bookId: string): BookDetailRecord | null => {
    const book = visibleBooks.find((item) => item.id === bookId) ?? null;
    const bundle = offlineLibrary.bundles[`book:${bookId}`];

    if (!book || !bundle) {
      return null;
    }

    const offlineTracks = bundle.trackIds.map(
      (trackId, index) =>
        tracks.find((track) => track.id === trackId && track.bookId === bookId) ??
        buildOfflineTrackStub(trackId, index, { mediaKind: "book", book })
    );

    return {
      book,
      tracks: offlineTracks,
      progress: null,
      bookmarks: []
    };
  };

  const buildOfflinePlaylistDetail = (playlistId: string): PlaylistRecord | null => {
    const playlist = fallbackVisiblePlaylists.find((item) => item.id === playlistId) ?? null;
    const bundle = offlineLibrary.bundles[`playlist:${playlistId}`];

    if (!playlist || !bundle) {
      return null;
    }

    const offlineTracks = bundle.trackIds.map(
      (trackId, index) =>
        tracks.find((track) => track.id === trackId) ??
        buildOfflineTrackStub(trackId, index, { mediaKind: "music" })
    );

    return {
      ...playlist,
      trackCount: offlineTracks.length,
      tracks: offlineTracks
    };
  };

  const currentQueueEntry = currentIndex >= 0 ? queue[currentIndex] ?? null : null;
  const currentTrack = currentIndex >= 0 ? queue[currentIndex]?.track ?? null : null;
  const currentTrackLiked = currentTrack ? likedTrackIds.has(currentTrack.id) : false;
  const currentOfflineUri = currentTrack ? getOfflineTrackUri(offlineLibrary, currentTrack.id) : null;
  const currentTrackIsBook = Boolean(currentTrack?.bookId);
  const currentCreatorName = currentTrack?.author ?? currentTrack?.artist ?? null;
  const currentCollectionName = currentTrack?.bookTitle ?? currentTrack?.album ?? null;
  useEffect(() => {
    setTrackPlayerServiceHandlers({
      onRemoteLike: currentTrack ? () => void toggleTrackLike(currentTrack) : null,
      onRemotePrevious: currentTrack
        ? () => {
            if (currentTrack.bookId) {
              void seekCurrentTrackBy(-20);
              return;
            }

            if (currentIndex > 0) {
              void playQueueAt(currentIndex - 1);
            }
          }
        : null,
      onRemoteNext: currentTrack
        ? () => {
            if (currentTrack.bookId) {
              void seekCurrentTrackBy(20);
              return;
            }

            if (currentIndex >= 0 && currentIndex < queue.length - 1) {
              void playQueueAt(currentIndex + 1);
            }
          }
        : null
    });
  }, [currentIndex, currentTrack, queue.length]);
  const upcomingQueueEntries = currentIndex >= 0 ? queue.slice(currentIndex + 1) : [];
  const likedTracks = useMemo(
    () => tracks.filter((track) => likedTrackIds.has(track.id)),
    [likedTrackIds, tracks]
  );
  const currentNavigationSnapshot = useMemo<NavigationSnapshot>(
    () => ({
      view,
      libraryMode,
      currentItem
    }),
    [currentItem, libraryMode, view]
  );

  const getTrackArtworkRemoteUri = (track: TrackRecord | null) =>
    track?.coverArtId && serverUrl ? getAbsoluteUrl(serverUrl, `/api/library/cover-art/${encodeURIComponent(track.coverArtId)}?variant=mobile`) : null;

  const buildLockScreenMetadata = (track: TrackRecord, artworkUrl?: string | null) => ({
    title: track.title ?? "Untitled track",
    artist: getBookTrackAuthor(track) ?? undefined,
    albumTitle: track.bookTitle ?? track.album ?? undefined,
    artworkUrl: artworkUrl ?? undefined
  });

  const supportsLockScreenControls = (player: AudioPlayer | null) =>
    Boolean(
      player &&
      typeof (player as AudioPlayer & {
        setActiveForLockScreen?: unknown;
        updateLockScreenMetadata?: unknown;
        clearLockScreenControls?: unknown;
      }).setActiveForLockScreen === "function" &&
      typeof (player as AudioPlayer & {
        setActiveForLockScreen?: unknown;
        updateLockScreenMetadata?: unknown;
        clearLockScreenControls?: unknown;
      }).updateLockScreenMetadata === "function" &&
      typeof (player as AudioPlayer & {
        setActiveForLockScreen?: unknown;
        updateLockScreenMetadata?: unknown;
        clearLockScreenControls?: unknown;
      }).clearLockScreenControls === "function"
    );

  const suspendLockScreenControlsForExternalPicker = async () => {
    if (Platform.OS !== "android") {
      return false;
    }

    const player = playerRef.current;
    if (!player || !supportsLockScreenControls(player) || !currentTrack) {
      return false;
    }

    try {
      await logInfo("Suspending lock screen controls before Android picker", {
        trackId: currentTrack.id,
        isPlaying
      });
      await player.clearLockScreenControls();
      return true;
    } catch (error) {
      await logError("Failed to suspend lock screen controls before Android picker", error, {
        trackId: currentTrack.id
      });
      return false;
    }
  };

  const restoreLockScreenControlsAfterExternalPicker = async (shouldRestore: boolean) => {
    if (!shouldRestore || Platform.OS !== "android" || !currentTrack) {
      return;
    }

    try {
      await logInfo("Restoring lock screen controls after Android picker", {
        trackId: currentTrack.id,
        isPlaying
      });
      await syncLockScreenState(currentTrack, { isPlaying });
    } catch (error) {
      await logError("Failed to restore lock screen controls after Android picker", error, {
        trackId: currentTrack.id
      });
    }
  };

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    queueAdvanceInFlightRef.current = null;
    lastHandledFinishRef.current = null;

    if (!currentTrack) {
      const player = playerRef.current;

      if (player && supportsLockScreenControls(player)) {
        player.clearLockScreenControls();
      }
      void clearNativeMediaBrowserNowPlaying();
      return;
    }

    void syncLockScreenState(currentTrack, { isPlaying });
  }, [currentTrack, isPlaying]);

  useEffect(() => {
    offlineLibraryRef.current = offlineLibrary;
  }, [offlineLibrary]);

  useEffect(() => {
    return () => {
      if (statusNoticeTimeoutRef.current) {
        clearTimeout(statusNoticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (visibleAlbums.length === 0) {
      setFeaturedAlbumId(null);
      return;
    }

    setFeaturedAlbumId((previous) => {
      if (previous && visibleAlbums.some((album) => album.id === previous)) {
        return previous;
      }

      return visibleAlbums[Math.floor(Math.random() * visibleAlbums.length)]?.id ?? visibleAlbums[0]?.id ?? null;
    });
  }, [visibleAlbums]);

  useEffect(() => {
    if (visibleBooks.length === 0) {
      setFeaturedBookId(null);
      return;
    }

    setFeaturedBookId((previous) => {
      if (previous && visibleBooks.some((book) => book.id === previous)) {
        return previous;
      }

      return visibleBooks[Math.floor(Math.random() * visibleBooks.length)]?.id ?? visibleBooks[0]?.id ?? null;
    });
  }, [visibleBooks]);

  useEffect(() => {
    if (fallbackVisiblePlaylists.length === 0) {
      setFeaturedPlaylistId(null);
      return;
    }

    setFeaturedPlaylistId((previous) => {
      if (previous && fallbackVisiblePlaylists.some((playlist) => playlist.id === previous)) {
        return previous;
      }

      return (
        fallbackVisiblePlaylists[Math.floor(Math.random() * fallbackVisiblePlaylists.length)]?.id ??
        fallbackVisiblePlaylists[0]?.id ??
        null
      );
    });
  }, [fallbackVisiblePlaylists]);

  useEffect(() => {
    if (allArtists.length === 0) {
      setFeaturedArtistId(null);
      return;
    }

    setFeaturedArtistId((previous) => {
      if (previous && allArtists.some((artist) => artist.id === previous)) {
        return previous;
      }

      return allArtists[Math.floor(Math.random() * allArtists.length)]?.id ?? allArtists[0]?.id ?? null;
    });
  }, [allArtists]);

  useEffect(() => {
    const normalized = trimmedSearchText;

    if (normalized.length === 0) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setSearchHistory((previous) => {
        const next = [normalized, ...previous.filter((term) => term.toLowerCase() !== normalized.toLowerCase())].slice(0, 12);
        void AsyncStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [trimmedSearchText]);

  useEffect(() => {
    if (!token) {
      navigationHistoryRef.current = [];
      return;
    }

    const nextKey = JSON.stringify(currentNavigationSnapshot);
    const previous = navigationHistoryRef.current[navigationHistoryRef.current.length - 1];
    const previousKey = previous ? JSON.stringify(previous) : null;

    if (restoringNavigationRef.current) {
      restoringNavigationRef.current = false;
      if (previousKey !== nextKey) {
        navigationHistoryRef.current = [...navigationHistoryRef.current, currentNavigationSnapshot];
      }
      return;
    }

    if (previousKey !== nextKey) {
      navigationHistoryRef.current = [...navigationHistoryRef.current, currentNavigationSnapshot];
    }
  }, [currentNavigationSnapshot, token]);

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
      interruptionModeAndroid: "doNotMix",
      shouldRouteThroughEarpiece: false
    }).catch((error) => {
      void logError("Audio mode configuration failed", error);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (keepAwakeWhilePlaying && isPlaying && currentTrack) {
          await activateKeepAwakeAsync(PLAYER_KEEP_AWAKE_TAG);
          return;
        }

        await deactivateKeepAwake(PLAYER_KEEP_AWAKE_TAG);
      } catch (error) {
        if (!cancelled) {
          await logError("Keep awake toggle failed", error, {
            hasCurrentTrack: Boolean(currentTrack),
            isPlaying,
            keepAwakeWhilePlaying
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentTrack, isPlaying, keepAwakeWhilePlaying]);

  useEffect(() => {
    void (async () => {
      try {
        await logInfo("Restoring persisted mobile state");
        const [storedUrl, storedToken, storedOffline, storedLibraryCache, storedKeepAwake, storedLoggingEnabled, storedLastListenedEntity, storedBookProgress] = await Promise.all([
          AsyncStorage.getItem(SERVER_URL_KEY),
          AsyncStorage.getItem(SESSION_TOKEN_KEY),
          loadOfflineLibrary(),
          AsyncStorage.getItem(LIBRARY_CACHE_KEY),
          AsyncStorage.getItem(KEEP_AWAKE_WHILE_PLAYING_KEY),
          AsyncStorage.getItem(APP_LOGGING_ENABLED_KEY),
          readLastListenedEntity(),
          readPersistedBookProgress()
        ]);
        const storedSearchHistory = await AsyncStorage.getItem(SEARCH_HISTORY_KEY);
        const nextKeepAwakeWhilePlaying = storedKeepAwake === "true";
        const nextLoggingEnabled = storedLoggingEnabled === "true";

        if (storedUrl) {
          setServerUrl(storedUrl);
        }

        if (storedToken) {
          setToken(storedToken);
        }

        setOfflineLibrary(storedOffline);
        setSearchHistory(storedSearchHistory ? JSON.parse(storedSearchHistory) : []);
        setKeepAwakeWhilePlaying(nextKeepAwakeWhilePlaying);
        setLoggingEnabled(nextLoggingEnabled);
        setAppLoggingEnabled(nextLoggingEnabled);
        setLastListenedEntity(storedLastListenedEntity);

        if (storedLibraryCache) {
          try {
            const parsedCache = JSON.parse(storedLibraryCache) as Partial<PersistedLibraryCache>;
            setAlbums(Array.isArray(parsedCache.albums) ? parsedCache.albums : []);
            setBooks(
              Array.isArray(parsedCache.books)
                ? mergeBooksWithLocalProgress(parsedCache.books, storedBookProgress)
                : []
            );
            setPlaylists(Array.isArray(parsedCache.playlists) ? parsedCache.playlists : []);
            setTracks(Array.isArray(parsedCache.tracks) ? parsedCache.tracks : []);
            setLikedTrackIds(new Set(Array.isArray(parsedCache.likedTrackIds) ? parsedCache.likedTrackIds : []));
            if (typeof parsedCache.summaryText === "string" && parsedCache.summaryText.length > 0) {
              setSummaryText(parsedCache.summaryText);
            }
            await syncNativeMediaBrowserLibraryCache({
              albums: Array.isArray(parsedCache.albums) ? parsedCache.albums : [],
              books: Array.isArray(parsedCache.books)
                ? mergeBooksWithLocalProgress(parsedCache.books, storedBookProgress)
                : [],
              playlists: Array.isArray(parsedCache.playlists) ? parsedCache.playlists : [],
              tracks: Array.isArray(parsedCache.tracks) ? parsedCache.tracks : [],
              likedTrackIds: Array.isArray(parsedCache.likedTrackIds) ? parsedCache.likedTrackIds : [],
              summaryText:
                typeof parsedCache.summaryText === "string" && parsedCache.summaryText.length > 0
                  ? parsedCache.summaryText
                  : "Your listening library"
            });
          } catch (cacheError) {
            await logError("Persisted library cache restore failed", cacheError);
          }
        }

        await logInfo("Persisted state restored", {
          hasServerUrl: Boolean(storedUrl),
          hasToken: Boolean(storedToken),
          offlineBundleCount: Object.keys(storedOffline.bundles).length,
          hasLibraryCache: Boolean(storedLibraryCache),
          persistedBookProgressCount: Object.keys(storedBookProgress).length,
          hasLastListenedEntity: Boolean(storedLastListenedEntity),
          keepAwakeWhilePlaying: nextKeepAwakeWhilePlaying,
          loggingEnabled: nextLoggingEnabled
        });
      } catch (error) {
        await logError("Persisted state restore failed", error);
      } finally {
        setBusy(false);
        setStartupHydrated(true);
      }
    })();
  }, []);

  const refreshDiagnostics = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsExportNotice(null);

    try {
      setDiagnosticsLog(formatDiagnosticsPreview(await readAppLog()));
      setLockScreenDiagnostics(JSON.stringify(getTrackPlayerDiagnosticsSnapshot(), null, 2));
    } catch (error) {
      await logError("Diagnostics log refresh failed", error);
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const handleClearDiagnostics = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsExportNotice(null);

    try {
      await clearAppLog();
      await logInfo("Diagnostics log cleared from in-app console");
      setDiagnosticsLog(formatDiagnosticsPreview(await readAppLog()));
      setLockScreenDiagnostics(JSON.stringify(getTrackPlayerDiagnosticsSnapshot(), null, 2));
    } catch (error) {
      await logError("Diagnostics log clear failed", error);
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const exportDiagnosticsToDownloads = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsExportNotice(null);
    let restoreLockScreenAfterPicker = false;

    try {
      const latestLog = await readAppLog();
      const lockScreenSnapshot = JSON.stringify(getTrackPlayerDiagnosticsSnapshot(), null, 2);
      const exportBody = latestLog || "No log entries yet.";
      setDiagnosticsLog(formatDiagnosticsPreview(latestLog));
      setLockScreenDiagnostics(lockScreenSnapshot);

      if (Platform.OS !== "android") {
        await Share.share({ message: exportBody });
        setDiagnosticsExportNotice("Diagnostics shared because Downloads export is only available on Android.");
        return;
      }

      const initialUri = FileSystem.StorageAccessFramework.getUriForDirectoryInRoot("Download");
      const storedDirectoryUri = await AsyncStorage.getItem(DIAGNOSTICS_EXPORT_DIRECTORY_URI_KEY);
      await logInfo("Diagnostics export requesting directory permission", {
        initialUri,
        storedDirectoryUri,
        logLength: exportBody.length
      });
      restoreLockScreenAfterPicker = await suspendLockScreenControlsForExternalPicker();
      const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(storedDirectoryUri ?? initialUri);
      await restoreLockScreenControlsAfterExternalPicker(restoreLockScreenAfterPicker);
      restoreLockScreenAfterPicker = false;

      if (!permission.granted) {
        setDiagnosticsExportNotice("Downloads export was cancelled.");
        return;
      }

      await AsyncStorage.setItem(DIAGNOSTICS_EXPORT_DIRECTORY_URI_KEY, permission.directoryUri);
      setLastDiagnosticsExportDirectoryUri(permission.directoryUri);
      await logInfo("Diagnostics export directory granted", {
        directoryUri: permission.directoryUri
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const exportBaseName = `groovy-diagnostics-${timestamp}.txt`;
      const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
        permission.directoryUri,
        exportBaseName,
        "text/plain"
      );
      await logInfo("Diagnostics export file created", {
        fileUri
      });

      await FileSystem.StorageAccessFramework.writeAsStringAsync(fileUri, exportBody, {
        encoding: FileSystem.EncodingType.UTF8
      });
      setLastDiagnosticsExportUri(fileUri);

      const exportedFileName = decodeURIComponent(fileUri.split("/").pop() ?? `${exportBaseName}.txt`);

      await logInfo("Diagnostics exported to Android Downloads", {
        fileUri,
        exportedFileName,
        logLength: exportBody.length,
        includedLockScreenSnapshot: false
      });
      setDiagnosticsExportNotice(`Diagnostics saved to Downloads as ${exportedFileName}.`);
    } catch (error) {
      await logError("Diagnostics export failed", error);
      setDiagnosticsExportNotice("Could not save diagnostics to Downloads.");
    } finally {
      if (restoreLockScreenAfterPicker) {
        await restoreLockScreenControlsAfterExternalPicker(true);
      }
      setDiagnosticsBusy(false);
    }
  };

  const openDiagnosticsExportTarget = async (target: "file" | "folder") => {
    setDiagnosticsBusy(true);
    setDiagnosticsExportNotice(null);

    try {
      const targetUri =
        target === "file"
          ? lastDiagnosticsExportUri
          : lastDiagnosticsExportDirectoryUri ?? (await AsyncStorage.getItem(DIAGNOSTICS_EXPORT_DIRECTORY_URI_KEY));

      if (!targetUri) {
        setDiagnosticsExportNotice(
          target === "file"
            ? "Export a diagnostics file first, then open it from here."
            : "Choose a Downloads folder with Save to Downloads first."
        );
        return;
      }

      const canOpen = await Linking.canOpenURL(targetUri);

      if (!canOpen) {
        await logInfo("Diagnostics export target could not be opened directly", {
          target,
          targetUri
        });
        setDiagnosticsExportNotice(
          target === "file"
            ? "Android could not open the saved diagnostics file directly."
            : "Android could not open the chosen Downloads folder directly."
        );
        return;
      }

      await Linking.openURL(targetUri);
      await logInfo("Diagnostics export target opened", {
        target,
        targetUri
      });
      setDiagnosticsExportNotice(target === "file" ? "Opened the saved diagnostics file." : "Opened the chosen Downloads folder.");
    } catch (error) {
      await logError("Diagnostics export target open failed", error, {
        target,
        fileUri: lastDiagnosticsExportUri,
        directoryUri: lastDiagnosticsExportDirectoryUri
      });
      setDiagnosticsExportNotice(
        target === "file"
          ? "Could not open the saved diagnostics file."
          : "Could not open the chosen Downloads folder."
      );
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const shareFullDiagnosticsLog = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsExportNotice(null);

    try {
      const latestLog = await readAppLog();
      const exportBody = latestLog || "No log entries yet.";
      setDiagnosticsLog(formatDiagnosticsPreview(latestLog));
      await Share.share({ message: exportBody });
    } catch (error) {
      await logError("Diagnostics share failed", error);
      setDiagnosticsExportNotice("Could not share the log.");
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const updateKeepAwakeSetting = async (enabled: boolean) => {
    setKeepAwakeWhilePlaying(enabled);
    await AsyncStorage.setItem(KEEP_AWAKE_WHILE_PLAYING_KEY, enabled ? "true" : "false");
    if (!enabled) {
      await deactivateKeepAwake(PLAYER_KEEP_AWAKE_TAG).catch((error) => logError("Keep awake setting deactivation failed", error));
    }
  };

  const updateLoggingSetting = async (enabled: boolean) => {
    setLoggingEnabled(enabled);
    setAppLoggingEnabled(enabled);
    await AsyncStorage.setItem(APP_LOGGING_ENABLED_KEY, enabled ? "true" : "false");
    if (enabled) {
      await logInfo("Diagnostics logging enabled from mobile settings");
    } else {
      setDiagnosticsLog("");
      setDiagnosticsExportNotice(null);
    }
  };

  const copyDiagnosticsLogToClipboard = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsExportNotice(null);

    try {
      const latestLog = await readAppLog();
      const rawText = latestLog || "No log entries yet.";
      const truncated = rawText.length > CLIPBOARD_COPY_MAX_CHARACTERS;
      const textToCopy = truncated ? rawText.slice(rawText.length - CLIPBOARD_COPY_MAX_CHARACTERS) : rawText;
      const clipboard = nativeClipboardModuleRef.current;

      if (!clipboard?.copyText) {
        throw new Error("Native clipboard module is unavailable.");
      }

      await clipboard.copyText("Groovy diagnostics", textToCopy);
      setDiagnosticsLog(formatDiagnosticsPreview(rawText));
      await logInfo("Diagnostics copied to clipboard", {
        copiedLength: textToCopy.length,
        originalLength: rawText.length,
        truncated
      });
      setDiagnosticsExportNotice(
        truncated
          ? "Most recent diagnostics copied to clipboard. The copied text was trimmed to fit Android clipboard limits."
          : "Log copied to clipboard."
      );
    } catch (error) {
      await logError("Diagnostics log copy failed", error);
      setDiagnosticsExportNotice("Could not copy the log. Use Save to Downloads or Share Log instead.");
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const refreshLibrary = async (options?: { showBusy?: boolean; notifyOnFailure?: boolean }) => {
    if (!serverUrl || !token) {
      return;
    }

    const showBusy = options?.showBusy ?? true;

    if (showBusy) {
      setBusy(true);
    }

    try {
      await logInfo("Server discovery: starting authenticated library refresh", {
        serverUrl,
        hasToken: Boolean(token),
        showBusy,
        notifyOnFailure: Boolean(options?.notifyOnFailure)
      });
      const endpointResults = await Promise.all([
        (async () => {
          try {
            return { endpoint: "bootstrap" as const, ok: true as const, value: await fetchBootstrap(apiOptions) };
          } catch (error) {
            return { endpoint: "bootstrap" as const, ok: false as const, error };
          }
        })(),
        (async () => {
          try {
            return { endpoint: "summary" as const, ok: true as const, value: await fetchLibrarySummary(apiOptions) };
          } catch (error) {
            return { endpoint: "summary" as const, ok: false as const, error };
          }
        })(),
        (async () => {
          try {
            return { endpoint: "albums" as const, ok: true as const, value: await fetchAlbums(apiOptions) };
          } catch (error) {
            return { endpoint: "albums" as const, ok: false as const, error };
          }
        })(),
        (async () => {
          try {
            return { endpoint: "books" as const, ok: true as const, value: await fetchBooks(apiOptions) };
          } catch (error) {
            return { endpoint: "books" as const, ok: false as const, error };
          }
        })(),
        (async () => {
          try {
            return { endpoint: "playlists" as const, ok: true as const, value: await fetchPlaylists(apiOptions) };
          } catch (error) {
            return { endpoint: "playlists" as const, ok: false as const, error };
          }
        })(),
        (async () => {
          try {
            return { endpoint: "tracks" as const, ok: true as const, value: await fetchTracks(apiOptions) };
          } catch (error) {
            return { endpoint: "tracks" as const, ok: false as const, error };
          }
        })(),
        (async () => {
          try {
            return { endpoint: "likes" as const, ok: true as const, value: await fetchLikedTrackIds(apiOptions) };
          } catch (error) {
            return { endpoint: "likes" as const, ok: false as const, error };
          }
        })()
      ]);

      const persistedBookProgress = await readPersistedBookProgress();
      const failures = endpointResults.filter((result) => !result.ok);
      const successes = endpointResults.filter((result) => result.ok);
      const bootstrapFailure = endpointResults.find((result) => result.endpoint === "bootstrap" && !result.ok);
      const authFailures = failures.filter((result) => isApiAuthError(result.error));
      const networkFailures = failures.filter((result) => isApiNetworkError(result.error));

      if (bootstrapFailure && isApiAuthError(bootstrapFailure.error)) {
        await logInfo("Server discovery: authenticated refresh rejected saved session", {
          serverUrl,
          reason: bootstrapFailure.error.message
        });
        await resetSavedSession("Your session expired. Sign in again.");
        return;
      }

      if (authFailures.length > 0 && successes.length === 0) {
        await logInfo("Server discovery: authenticated refresh rejected saved session outside bootstrap", {
          serverUrl,
          failedEndpoints: authFailures.map((result) => result.endpoint)
        });
        await resetSavedSession("Your session expired. Sign in again.");
        return;
      }

      await Promise.all(
        failures.map((result) =>
          logError("Library endpoint refresh failed", result.error, {
            serverUrl,
            endpoint: result.endpoint
          })
        )
      );

      const bootstrap = endpointResults.find((result) => result.endpoint === "bootstrap" && result.ok)?.value ?? null;
      const summary = endpointResults.find((result) => result.endpoint === "summary" && result.ok)?.value ?? null;
      const nextAlbums = endpointResults.find((result) => result.endpoint === "albums" && result.ok)?.value ?? null;
      const nextBooks = endpointResults.find((result) => result.endpoint === "books" && result.ok)?.value ?? null;
      const nextPlaylists = endpointResults.find((result) => result.endpoint === "playlists" && result.ok)?.value ?? null;
      const nextTracks = endpointResults.find((result) => result.endpoint === "tracks" && result.ok)?.value ?? null;
      const likes = endpointResults.find((result) => result.endpoint === "likes" && result.ok)?.value ?? null;
      const derivedBooksFromServerTracks = nextBooks && nextBooks.length === 0 && nextTracks ? deriveBooksFromTracks(nextTracks) : [];
      const resolvedBooks = nextBooks && nextBooks.length === 0 && derivedBooksFromServerTracks.length > 0 ? derivedBooksFromServerTracks : nextBooks;
      const preserveExistingBooks = shouldPreserveExistingBooks({
        resolvedBooks,
        nextAlbums,
        nextTracks,
        currentBooksCount: books.length
      });
      const suspiciousEmptyLibraryResponse = isSuspiciousEmptyLibraryResponse({
        nextAlbums,
        nextBooks: resolvedBooks,
        nextPlaylists,
        nextTracks,
        currentAlbumsCount: albums.length,
        currentBooksCount: books.length,
        currentPlaylistsCount: playlists.length,
        currentTracksCount: tracks.length,
        offlineBundleCount: Object.keys(offlineLibraryRef.current.bundles).length
      });

      if (bootstrap) {
        await logInfo("Server discovery: bootstrap endpoint responded", {
          serverUrl,
          hasUsers: bootstrap.hasUsers
        });
        setBootstrapRequiresRegister(!bootstrap.hasUsers);
      }

      if (nextBooks && nextBooks.length === 0 && derivedBooksFromServerTracks.length > 0) {
        await logInfo("Books endpoint returned empty; derived books from track payload", {
          serverUrl,
          derivedBookCount: derivedBooksFromServerTracks.length,
          trackCount: nextTracks?.length ?? 0
        });
      }

      if (preserveExistingBooks) {
        await logInfo("Books endpoint returned empty; preserving existing books collection", {
          serverUrl,
          currentBooksCount: books.length,
          albumCount: nextAlbums?.length ?? 0,
          trackCount: nextTracks?.length ?? 0
        });
      }

      if (suspiciousEmptyLibraryResponse) {
        await logInfo("Server discovery: suspicious empty library response ignored", {
          serverUrl,
          currentAlbumsCount: albums.length,
          currentBooksCount: books.length,
          currentPlaylistsCount: playlists.length,
          currentTracksCount: tracks.length,
          nextAlbumsCount: nextAlbums?.length ?? null,
          nextBooksCount: nextBooks?.length ?? null,
          nextPlaylistsCount: nextPlaylists?.length ?? null,
          nextTracksCount: nextTracks?.length ?? null,
          offlineBundleCount: Object.keys(offlineLibraryRef.current.bundles).length
        });

        if (options?.notifyOnFailure) {
          showStatusNotice("Server responded with an empty library snapshot. Keeping your cached library.");
        }
      }

      if (summary || nextAlbums || nextBooks || nextPlaylists || nextTracks || likes) {
        setCoverArtRefreshKey(new Date().toISOString());
      }

      if (nextAlbums && !suspiciousEmptyLibraryResponse) {
        setAlbums(nextAlbums);
      }
      if (resolvedBooks && !suspiciousEmptyLibraryResponse && !preserveExistingBooks) {
        setBooks(mergeBooksWithLocalProgress(resolvedBooks, persistedBookProgress));
      }
      if (nextPlaylists && !suspiciousEmptyLibraryResponse) {
        setPlaylists(nextPlaylists);
      }
      if (nextTracks && !suspiciousEmptyLibraryResponse) {
        setTracks(nextTracks);
      }
      if (likes) {
        setLikedTrackIds(new Set(likes.trackIds));
      }
      if (summary) {
        setSummaryText(summary.lastScanAt ? `${summary.trackCount} tracks indexed` : "Scan your library to begin");
      }

      if (summary && nextAlbums && resolvedBooks && nextPlaylists && nextTracks && likes && !suspiciousEmptyLibraryResponse && !preserveExistingBooks) {
        const mergedBooks = mergeBooksWithLocalProgress(resolvedBooks, persistedBookProgress);
        const nextLibraryCache = {
          albums: nextAlbums,
          books: mergedBooks,
          playlists: nextPlaylists,
          tracks: nextTracks,
          likedTrackIds: likes.trackIds,
          summaryText: summary.lastScanAt ? `${summary.trackCount} tracks indexed` : "Scan your library to begin"
        } satisfies PersistedLibraryCache;
        await AsyncStorage.setItem(
          LIBRARY_CACHE_KEY,
          JSON.stringify(nextLibraryCache)
        );
        await syncNativeMediaBrowserLibraryCache(nextLibraryCache);
      }

      if (resolvedBooks && !preserveExistingBooks) {
        void reconcileBookProgressWithServer(resolvedBooks, persistedBookProgress, "refreshLibrary");
      }

      if (Object.keys(offlineLibraryRef.current.bundles).length > 0) {
        const nextOfflineLibrary = await refreshOfflineCoverArt(offlineLibraryRef.current, serverUrl, token);
        offlineLibraryRef.current = nextOfflineLibrary;
        setOfflineLibrary(nextOfflineLibrary);
        await logInfo("Offline cover art refreshed after library refresh", {
          serverUrl,
          bundleCount: Object.keys(nextOfflineLibrary.bundles).length
        });
      }

      if (failures.length === 0) {
        setStatusNotice(null);
      } else if (options?.notifyOnFailure && successes.length === 0) {
        showStatusNotice(
          networkFailures.length > 0
            ? Object.keys(offlineLibraryRef.current.bundles).length > 0
              ? "Server unavailable. Showing synced content."
              : "Server unavailable. Pull to refresh when it comes back."
            : authFailures.length > 0
              ? "Saved sign-in was rejected. Please sign in again."
              : "Connected to the server, but the library response was incomplete.",
          {
            source: successes.length > 0 ? "refreshLibrary.partialFailure.suppressedToast" : "refreshLibrary.partialFailure",
            serverUrl,
            successfulEndpoints: successes.map((result) => result.endpoint),
            failedEndpoints: failures.map((result) => result.endpoint),
            failedEndpointKinds: failures.map((result) =>
              isApiAuthError(result.error) ? "auth" : isApiNetworkError(result.error) ? "network" : "other"
            ),
            hasOfflineBundles: Object.keys(offlineLibraryRef.current.bundles).length > 0
          }
        );
      }

      await logInfo("Library refresh completed", {
        serverUrl,
        successfulEndpoints: successes.map((result) => result.endpoint),
        failedEndpoints: failures.map((result) => result.endpoint),
        failedEndpointKinds: failures.map((result) =>
          isApiAuthError(result.error) ? "auth" : isApiNetworkError(result.error) ? "network" : "other"
        ),
        suspiciousEmptyLibraryResponse,
        preserveExistingBooks,
        persistedBookProgressCount: Object.keys(persistedBookProgress).length,
        albumCount: nextAlbums?.length ?? null,
        bookCount: resolvedBooks?.length ?? null,
        derivedBookCount: derivedBooksFromServerTracks.length,
        playlistCount: nextPlaylists?.length ?? null,
        trackCount: nextTracks?.length ?? null,
        likedTrackCount: likes?.trackIds.length ?? null
      });
    } catch (error) {
      await logError("Library refresh failed", error, { serverUrl });
      if (options?.notifyOnFailure) {
        showStatusNotice(
          Object.keys(offlineLibraryRef.current.bundles).length > 0
            ? "Server unavailable. Showing synced content."
            : "Server unavailable. Pull to refresh when it comes back.",
          {
            source: "refreshLibrary.catch",
            serverUrl,
            errorKind: isApiNetworkError(error) ? "network" : isApiAuthError(error) ? "auth" : "other",
            hasOfflineBundles: Object.keys(offlineLibraryRef.current.bundles).length > 0
          }
        );
      }
    } finally {
      if (showBusy) {
        setBusy(false);
      }
    }
  };

  const handlePullToRefresh = async () => {
    if (!serverUrl || !token || refreshing) {
      return;
    }

    setRefreshing(true);

    try {
      await refreshLibrary({ showBusy: false, notifyOnFailure: true });

      if (view === "downloads") {
        await refreshDiagnostics();
      }

      if (view === "library" && currentItem?.type === "album") {
        setAlbumDetail(await fetchAlbumDetail(apiOptions, currentItem.id));
      }

      if (view === "library" && currentItem?.type === "book") {
        const [detail, persistedProgress] = await Promise.all([
          fetchBookDetail(apiOptions, currentItem.id),
          readPersistedBookProgress()
        ]);
        setBookServerProgress(detail.progress ?? null);
        setBookDetail(mergeBookProgress(detail, persistedProgress[currentItem.id] ?? null));
      }

      await logInfo("Pull to refresh completed", {
        view,
        currentItemType: currentItem?.type ?? null,
        currentItemId: currentItem?.id ?? null
      });
    } catch (error) {
      await logError("Pull to refresh failed", error, {
        view,
        currentItemType: currentItem?.type ?? null,
        currentItemId: currentItem?.id ?? null
      });
    } finally {
      setRefreshing(false);
    }
  };

  const toggleTrackLike = async (track: TrackRecord) => {
    if (!token || !serverUrl) {
      return;
    }

    const wasLiked = likedTrackIds.has(track.id);
    const nextLikedIds = wasLiked ? Array.from(likedTrackIds).filter((id) => id !== track.id) : [...likedTrackIds, track.id];

    setLikedTrackIds((previous) => {
      const next = new Set(previous);
      if (wasLiked) {
        next.delete(track.id);
      } else {
        next.add(track.id);
      }
      return next;
    });

    try {
      if (wasLiked) {
        await unlikeTrack(apiOptions, track.id);
      } else {
        await likeTrack(apiOptions, track.id);
      }
      const nextLibraryCache = {
        albums,
        books,
        playlists,
        tracks,
        likedTrackIds: nextLikedIds,
        summaryText
      } satisfies PersistedLibraryCache;
      await AsyncStorage.setItem(
        LIBRARY_CACHE_KEY,
        JSON.stringify(nextLibraryCache)
      );
      await syncNativeMediaBrowserLibraryCache(nextLibraryCache);

      if (currentTrack?.id === track.id) {
        await syncLockScreenState(track, { isPlaying });
      }
    } catch (error) {
      setLikedTrackIds((previous) => {
        const next = new Set(previous);
        if (wasLiked) {
          next.add(track.id);
        } else {
          next.delete(track.id);
        }
        return next;
      });
      await logError("Track like toggle failed", error, {
        trackId: track.id,
        wasLiked
      });
      showStatusNotice(wasLiked ? "Could not remove from liked songs." : "Could not add to liked songs.");
    }
  };

  const refreshPlaylistCollection = async () => {
    if (!token || !serverUrl) {
      return;
    }

    const nextPlaylists = await fetchPlaylists(apiOptions);
    setPlaylists(nextPlaylists);

    const nextLibraryCache = {
      albums,
      books,
      playlists: nextPlaylists,
      tracks,
      likedTrackIds: Array.from(likedTrackIds),
      summaryText
    } satisfies PersistedLibraryCache;
    await AsyncStorage.setItem(
      LIBRARY_CACHE_KEY,
      JSON.stringify(nextLibraryCache)
    );
    await syncNativeMediaBrowserLibraryCache(nextLibraryCache);
  };

  const openPlaylistPicker = (track: TrackRecord) => {
    setPlaylistPickerState({
      track,
      creating: false,
      title: "",
      busy: false,
      error: null
    });
  };

  const closePlaylistPicker = () => {
    setPlaylistPickerState(null);
  };

  const addTrackToSelectedPlaylist = async (playlistId: string) => {
    if (!playlistPickerState || !token || !serverUrl) {
      return;
    }

    setPlaylistPickerState((previous) => (previous ? { ...previous, busy: true, error: null } : previous));

    try {
      await addTrackToPlaylist(apiOptions, playlistId, playlistPickerState.track.id);
      await refreshPlaylistCollection();

      if (currentItem?.type === "playlist" && currentItem.id === playlistId) {
        openPlaylist(playlistId);
      }

      showStatusNotice(`Added "${playlistPickerState.track.title ?? "track"}" to playlist.`);
      closePlaylistPicker();
    } catch (error) {
      await logError("Add track to playlist failed", error, {
        trackId: playlistPickerState.track.id,
        playlistId
      });
      setPlaylistPickerState((previous) => (previous ? { ...previous, busy: false, error: "Could not add track to playlist." } : previous));
    }
  };

  const submitCreatePlaylist = async () => {
    if (!playlistPickerState || !token || !serverUrl) {
      return;
    }

    const name = playlistPickerState.title.trim();

    if (name.length === 0) {
      setPlaylistPickerState((previous) => (previous ? { ...previous, error: "Enter a playlist name." } : previous));
      return;
    }

    setPlaylistPickerState((previous) => (previous ? { ...previous, busy: true, error: null } : previous));

    try {
      const createdPlaylist = await createPlaylist(apiOptions, name);
      await addTrackToPlaylist(apiOptions, createdPlaylist.id, playlistPickerState.track.id);
      await refreshPlaylistCollection();
      showStatusNotice(`Created "${createdPlaylist.name}" and added the track.`);
      closePlaylistPicker();
    } catch (error) {
      await logError("Create playlist from mobile failed", error, {
        trackId: playlistPickerState.track.id,
        playlistName: name
      });
      setPlaylistPickerState((previous) => (previous ? { ...previous, busy: false, error: "Could not create playlist." } : previous));
    }
  };

  const advanceToNextQueueTrack = async (finishedTrack: { trackId: string; index: number }) => {
    const activeQueue = [...queueRef.current];
    const activeIndex = finishedTrack.index;
    const nextEntry = activeQueue[activeIndex + 1] ?? null;

    void logInfo("Queue advance requested", {
      activeIndex,
      queueLength: activeQueue.length,
      finishedTrackId: finishedTrack.trackId,
      currentTrackId: activeQueue[activeIndex]?.track.id ?? null,
      nextTrackId: nextEntry?.track.id ?? null
    });

    if (activeIndex >= 0 && activeIndex < activeQueue.length - 1) {
      lastAdvanceAttemptRef.current = {
        fromIndex: activeIndex,
        toIndex: activeIndex + 1,
        at: Date.now()
      };
      logPlayerDebugSnapshot("Queue advance scheduled", {
        fromIndex: activeIndex,
        toIndex: activeIndex + 1,
        nextTrackId: nextEntry?.track.id ?? null
      });
      scheduleAdvanceDiagnostics("scheduled", activeIndex + 1, nextEntry?.track.id ?? null);
      setPendingQueueAdvance({
        index: activeIndex + 1,
        queue: activeQueue,
        finishedTrackId: finishedTrack.trackId,
        requestedAt: Date.now()
      });
      return;
    }

    queueAdvanceInFlightRef.current = null;
    void logInfo("Queue advance reached end of queue", {
      activeIndex,
      queueLength: activeQueue.length
    });
    setIsPlaying(false);
  };

  const openLikedSongs = () => {
    setSearchText("");
    setCurrentItem(null);
    setView("liked");
    setMobileMenuOpen(false);
  };

  useEffect(() => {
    if (!pendingQueueAdvance) {
      return;
    }

    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const attemptAdvance = async (attempt: number) => {
      if (cancelled) {
        return;
      }

      const entry = pendingQueueAdvance.queue[pendingQueueAdvance.index] ?? null;
      const hasPlayer = Boolean(playerRef.current);
      const hasServerUrl = Boolean(serverUrl);

      logPlayerDebugSnapshot("Queue advance effect attempt", {
        attempt,
        targetIndex: pendingQueueAdvance.index,
        targetTrackId: entry?.track.id ?? null,
        finishedTrackId: pendingQueueAdvance.finishedTrackId,
        hasPlayer,
        hasServerUrl,
        queuedAt: pendingQueueAdvance.requestedAt
      });

      if (!entry || !hasPlayer || !hasServerUrl) {
        if (attempt < 4) {
          retryTimeout = setTimeout(() => {
            void attemptAdvance(attempt + 1);
          }, 150);
          return;
        }

        queueAdvanceInFlightRef.current = null;
        setPendingQueueAdvance(null);
        void logInfo("Queue advance abandoned after retries", {
          attempt,
          targetIndex: pendingQueueAdvance.index,
          targetTrackId: entry?.track.id ?? null,
          finishedTrackId: pendingQueueAdvance.finishedTrackId,
          hasPlayer,
          hasServerUrl
        });
        return;
      }

      try {
        await playQueueAt(pendingQueueAdvance.index, 0, pendingQueueAdvance.queue);
        if (cancelled) {
          return;
        }
        logPlayerDebugSnapshot("Queue advance effect completed", {
          attempt,
          targetIndex: pendingQueueAdvance.index,
          targetTrackId: entry.track.id,
          finishedTrackId: pendingQueueAdvance.finishedTrackId
        });
        setPendingQueueAdvance(null);
      } catch (error) {
        if (attempt < 4 && !cancelled) {
          void logError("Queue advance effect attempt failed", error, {
            attempt,
            targetIndex: pendingQueueAdvance.index,
            targetTrackId: entry.track.id,
            finishedTrackId: pendingQueueAdvance.finishedTrackId
          });
          retryTimeout = setTimeout(() => {
            void attemptAdvance(attempt + 1);
          }, 150);
          return;
        }

        queueAdvanceInFlightRef.current = null;
        setPendingQueueAdvance(null);
        void logError("Queue advance failed", error, {
          attempt,
          targetIndex: pendingQueueAdvance.index,
          targetTrackId: entry.track.id,
          finishedTrackId: pendingQueueAdvance.finishedTrackId
        });
      }
    };

    void attemptAdvance(1);

    return () => {
      cancelled = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [pendingQueueAdvance, serverUrl]);

  useEffect(() => {
    if (!normalizedServerUrl) {
      return;
    }

    if (!token) {
      const looksLikeFullServerUrl = /^https?:\/\/.+/i.test(normalizedServerUrl);

      if (!looksLikeFullServerUrl) {
        setBootstrapRequiresRegister(false);
        setAuthMode("login");
        setAuthError(null);
        return;
      }

      const bootstrapTimeoutId = setTimeout(() => {
        void (async () => {
          try {
            await logInfo("Server discovery: starting pre-login probe", {
              serverUrl: normalizedServerUrl
            });
            await probeServer(normalizedServerUrl);
            await logInfo("Server discovery: pre-login probe succeeded", {
              serverUrl: normalizedServerUrl
            });
            const bootstrap = await fetchBootstrap({ serverUrl: normalizedServerUrl, token: null });
            await logInfo("Server discovery: bootstrap endpoint responded", {
              serverUrl: normalizedServerUrl,
              hasUsers: bootstrap.hasUsers
            });
            setBootstrapRequiresRegister(!bootstrap.hasUsers);
            setAuthMode(bootstrap.hasUsers ? "login" : "register");
            setAuthError(null);
          } catch (error) {
            await logError("Bootstrap check failed before login", error, { serverUrl: normalizedServerUrl });
            setBootstrapRequiresRegister(false);
            setAuthMode("login");
            setAuthError(
              error instanceof Error
                ? error.message
                : "Could not connect to the server. Use your LAN URL, for example http://192.168.1.10:4318."
            );
          }
        })();
      }, 450);

      return () => {
        clearTimeout(bootstrapTimeoutId);
      };
    }

    void refreshLibrary({ showBusy: false, notifyOnFailure: false });
  }, [normalizedServerUrl, token]);

  useEffect(() => {
    if (!normalizedServerUrl || token) {
      return;
    }

    if (!/^https?:\/\/.+/i.test(normalizedServerUrl)) {
      return;
    }

    void logInfo("Server URL ready for bootstrap probe", {
      serverUrl: normalizedServerUrl
    });
  }, [normalizedServerUrl, token]);

  useEffect(() => {
    let player: AudioPlayer | null = null;

    try {
      player = createAudioPlayer(null, { updateInterval: 2000 });
      playerRef.current = player;
      void logInfo("Audio player created", {
        hasAddListener: typeof (player as AudioPlayer & { addListener?: unknown }).addListener === "function",
        hasRemove: typeof (player as AudioPlayer & { remove?: unknown }).remove === "function"
      });

      if (typeof (player as AudioPlayer & { addListener?: unknown }).addListener !== "function") {
        void logError("Audio player is missing addListener", null, {
          playerType: typeof player
        });
      } else {
        playerSubscriptionRef.current = player.addListener("playbackStatusUpdate", (status: AudioStatus) => {
          const nativeStatus = status as NativeQueueAudioStatus;
          const activeQueueIndex =
            typeof nativeStatus.currentMediaItemIndex === "number" && nativeStatus.currentMediaItemIndex >= 0
              ? nativeStatus.currentMediaItemIndex
              : currentIndexRef.current;
          const activeTrack = queueRef.current[activeQueueIndex]?.track ?? null;
          const nextPositionSeconds = Math.max(0, status.currentTime || 0);
          const previousBookProgress =
            activeTrack?.bookId &&
            latestBookProgressRef.current?.bookId === activeTrack.bookId &&
            latestBookProgressRef.current.trackId === activeTrack.id
              ? latestBookProgressRef.current
              : null;
          const recentExplicitSeek =
            activeTrack &&
            lastExplicitSeekRef.current?.trackId === activeTrack.id &&
            Date.now() - lastExplicitSeekRef.current.at < 10000
              ? lastExplicitSeekRef.current
              : null;
          const shouldIgnoreBookProgressRegression =
            Boolean(activeTrack?.bookId) &&
            Boolean(previousBookProgress) &&
            !recentExplicitSeek &&
            !status.didJustFinish &&
            !status.playing &&
            nextPositionSeconds + 5 < (previousBookProgress?.positionSeconds ?? 0);
          const statusSummary = JSON.stringify({
            playbackState: status.playbackState,
            timeControlStatus: status.timeControlStatus,
            playing: status.playing,
            didJustFinish: status.didJustFinish,
            currentMediaItemIndex:
              typeof nativeStatus.currentMediaItemIndex === "number" ? nativeStatus.currentMediaItemIndex : null
          });
          if (statusSummary !== lastPlaybackStatusSummaryRef.current) {
            lastPlaybackStatusSummaryRef.current = statusSummary;
            logPlayerDebugSnapshot("Playback status transition", {
              playbackState: status.playbackState,
              timeControlStatus: status.timeControlStatus,
              playing: status.playing,
              didJustFinish: status.didJustFinish,
              currentTime: status.currentTime,
              duration: status.duration,
              currentMediaItemIndex:
                typeof nativeStatus.currentMediaItemIndex === "number" ? nativeStatus.currentMediaItemIndex : null,
              currentMediaItemCount:
                typeof nativeStatus.currentMediaItemCount === "number" ? nativeStatus.currentMediaItemCount : null
            });
          }
          setIsPlaying(status.playing);
          if (shouldIgnoreBookProgressRegression) {
            void logInfo("Ignored regressive book playback update", {
              trackId: activeTrack?.id ?? null,
              bookId: activeTrack?.bookId ?? null,
              currentTime: nextPositionSeconds,
              cachedPositionSeconds: previousBookProgress?.positionSeconds ?? null,
              playing: status.playing,
              didJustFinish: status.didJustFinish
            });
          } else {
            setPlaybackPosition(nextPositionSeconds);
            if (activeTrack?.bookId) {
              rememberBookProgress(activeTrack, nextPositionSeconds);
            }
          }
          setPlaybackDuration(status.duration || 0);

          if (
            typeof nativeStatus.currentMediaItemIndex === "number" &&
            nativeStatus.currentMediaItemIndex >= 0 &&
            nativeStatus.currentMediaItemIndex !== currentIndexRef.current &&
            nativeStatus.currentMediaItemIndex < queueRef.current.length
          ) {
            currentIndexRef.current = nativeStatus.currentMediaItemIndex;
            setCurrentIndex(nativeStatus.currentMediaItemIndex);
            queueAdvanceInFlightRef.current = null;
            lastHandledFinishRef.current = null;
            const nextTrack = queueRef.current[nativeStatus.currentMediaItemIndex]?.track ?? null;
            if (nextTrack) {
              setPlaybackDuration(nextTrack.durationSeconds ?? status.duration ?? 0);
              void logInfo("Native queue item changed", {
                currentIndex: nativeStatus.currentMediaItemIndex,
                queueLength: queueRef.current.length,
                trackId: nextTrack.id
              });
              void prefetchQueuedTrack(queueRef.current[nativeStatus.currentMediaItemIndex + 1] ?? null);
            }
          }

          const didReachTrackEnd =
            status.duration > 0 &&
            !status.playing &&
            Math.abs((status.duration || 0) - (status.currentTime || 0)) <= 0.35;

          if (!status.didJustFinish && !didReachTrackEnd) {
            return;
          }

          const finishedTrackId = queueRef.current[currentIndexRef.current]?.track.id ?? null;
          const finishSignature = finishedTrackId
            ? {
                trackId: finishedTrackId,
                index: currentIndexRef.current
              }
            : null;
          const previousFinish = lastHandledFinishRef.current;
          const inFlightAdvance = queueAdvanceInFlightRef.current;
          const recentStart = lastTrackStartRef.current;
          const staleFinishEcho =
            Boolean(recentStart) &&
            recentStart!.trackId === finishedTrackId &&
            recentStart!.index === currentIndexRef.current &&
            Date.now() - recentStart!.at < 2500;
          const advanceAlreadyInFlight =
            Boolean(finishSignature) &&
            Boolean(inFlightAdvance) &&
            inFlightAdvance!.trackId === finishSignature?.trackId &&
            inFlightAdvance!.index === finishSignature?.index;

          void logInfo("Playback finish signal received", {
            finishedTrackId,
            currentIndex: currentIndexRef.current,
            queueLength: queueRef.current.length,
            lastHandledFinish: previousFinish,
            queueAdvanceInFlight: inFlightAdvance,
            recentStart,
            staleFinishEcho,
            advanceAlreadyInFlight,
            didJustFinish: status.didJustFinish,
            didReachTrackEnd,
            currentTime: status.currentTime,
            duration: status.duration,
            isPlaying: status.playing
          });

          if (typeof getNativeQueuePlayer()?.replaceQueue === "function") {
            logPlayerDebugSnapshot("Playback finish delegated to native queue", {
              finishedTrackId,
              currentIndex: currentIndexRef.current,
              queueLength: queueRef.current.length
            });
            if (currentIndexRef.current >= queueRef.current.length - 1) {
              queueAdvanceInFlightRef.current = null;
            }
            return;
          }

          if (!finishedTrackId || advanceAlreadyInFlight || staleFinishEcho) {
            void logInfo("Playback finish signal ignored", {
              finishedTrackId,
              currentIndex: currentIndexRef.current,
              queueLength: queueRef.current.length,
              lastHandledFinish: previousFinish,
              queueAdvanceInFlight: inFlightAdvance,
              recentStart,
              staleFinishEcho,
              advanceAlreadyInFlight
            });
            return;
          }

          lastHandledFinishRef.current = {
            trackId: finishedTrackId,
            index: currentIndexRef.current,
            at: Date.now()
          };
          queueAdvanceInFlightRef.current = {
            trackId: finishedTrackId,
            index: currentIndexRef.current
          };
          void advanceToNextQueueTrack({
            trackId: finishedTrackId,
            index: currentIndexRef.current
          });
        });
      }
    } catch (error) {
      void logError("Audio player setup failed", error);
    }

    return () => {
      try {
        playerSubscriptionRef.current?.remove();
        if (player && supportsLockScreenControls(player)) {
          player.clearLockScreenControls();
        }
        player?.remove();
      } catch (error) {
        void logError("Audio player cleanup failed", error);
      } finally {
        playerSubscriptionRef.current = null;
        playerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (view === "downloads") {
      void refreshDiagnostics();
    }
  }, [view]);

  const cacheArtworkForLockScreen = async (track: TrackRecord) => {
    const offlineArtworkUri = getOfflineCoverUri(offlineLibraryRef.current, track.id, track.coverArtId);

    if (offlineArtworkUri) {
      return offlineArtworkUri;
    }

    const remoteArtworkUri = getTrackArtworkRemoteUri(track);

    if (!remoteArtworkUri || !FileSystem.cacheDirectory) {
      return null;
    }

    try {
      const directoryInfo = await FileSystem.getInfoAsync(LOCK_SCREEN_ARTWORK_DIRECTORY);

      if (!directoryInfo.exists) {
        await FileSystem.makeDirectoryAsync(LOCK_SCREEN_ARTWORK_DIRECTORY, { intermediates: true });
      }

      const targetFileUri = `${LOCK_SCREEN_ARTWORK_DIRECTORY}/${encodeURIComponent(track.coverArtId ?? track.id)}.jpg`;
      const existing = await FileSystem.getInfoAsync(targetFileUri);

      if (!existing.exists) {
        await FileSystem.downloadAsync(remoteArtworkUri, targetFileUri, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
      }

      return targetFileUri;
    } catch (error) {
      await logError("Lock screen artwork cache failed", error, {
        trackId: track.id,
        coverArtId: track.coverArtId ?? null
      });
      return null;
    }
  };

  const resolveArtworkForMediaMetadata = async (track: TrackRecord) => {
    const artworkUri = await cacheArtworkForLockScreen(track);

    if (!artworkUri) {
      await logInfo("Android media artwork resolution produced no artwork", {
        trackId: track.id,
        coverArtId: track.coverArtId ?? null,
        hasOfflineArtwork: Boolean(getOfflineCoverUri(offlineLibraryRef.current, track.id, track.coverArtId))
      });
      return null;
    }

    if (Platform.OS !== "android" || !artworkUri.startsWith("file:")) {
      await logInfo("Android media artwork resolution returned URI without content conversion", {
        trackId: track.id,
        coverArtId: track.coverArtId ?? null,
        artworkUri,
        artworkUriScheme: getUriScheme(artworkUri)
      });
      return artworkUri;
    }

    const cachedContentUri = mediaArtworkUriCacheRef.current[artworkUri];

    if (cachedContentUri) {
      await logInfo("Android media artwork content URI cache hit", {
        trackId: track.id,
        coverArtId: track.coverArtId ?? null,
        artworkUri,
        contentUri: cachedContentUri
      });
      return cachedContentUri;
    }

    try {
      const contentUri =
        (await nativeMediaBrowserModuleRef.current?.buildArtworkContentUri?.(artworkUri)) ??
        (await FileSystem.getContentUriAsync(artworkUri));
      mediaArtworkUriCacheRef.current[artworkUri] = contentUri;
      await logInfo("Android media artwork content URI prepared", {
        trackId: track.id,
        coverArtId: track.coverArtId ?? null,
        artworkUri,
        contentUri,
        contentUriScheme: getUriScheme(contentUri)
      });
      return contentUri;
    } catch (error) {
      await logError("Android media artwork content URI conversion failed", error, {
        trackId: track.id,
        coverArtId: track.coverArtId ?? null,
        artworkUri
      });
      return artworkUri;
    }
  };

  const cacheTrackForPlayback = async (track: TrackRecord) => {
    if (!serverUrl || !token || !shouldCacheTrackForPlayback(track)) {
      return null;
    }

    const targetFileUri = getPlaybackCacheUri(track);
    const existing = await FileSystem.getInfoAsync(targetFileUri).catch(() => ({ exists: false } as const));

    if (existing.exists) {
      return targetFileUri;
    }

    if (playbackCacheDownloadsRef.current.has(track.id)) {
      return null;
    }

    playbackCacheDownloadsRef.current.add(track.id);

    try {
      const directoryInfo = await FileSystem.getInfoAsync(PLAYBACK_CACHE_DIRECTORY);

      if (!directoryInfo.exists) {
        await FileSystem.makeDirectoryAsync(PLAYBACK_CACHE_DIRECTORY, { intermediates: true });
      }

      await FileSystem.downloadAsync(
        getAbsoluteUrl(serverUrl, `/api/library/stream/${encodeURIComponent(track.id)}`),
        targetFileUri,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      await logInfo("Playback cache stored", {
        trackId: track.id,
        localUri: targetFileUri
      });
      return targetFileUri;
    } catch (error) {
      await logError("Playback cache failed", error, {
        trackId: track.id
      });
      return null;
    } finally {
      playbackCacheDownloadsRef.current.delete(track.id);
    }
  };

  const prefetchQueuedTrack = async (entry: QueueEntry | null) => {
    if (!entry || !shouldCacheTrackForPlayback(entry.track)) {
      return;
    }

    await cacheTrackForPlayback(entry.track);
  };

  const syncLockScreenState = async (track: TrackRecord, options?: { isPlaying?: boolean }) => {
    const player = playerRef.current;

    if (!player || !supportsLockScreenControls(player)) {
      return;
    }

    try {
      await ensureNotificationPermission();
      const artworkUri = await resolveArtworkForMediaMetadata(track);
      const metadata = buildLockScreenMetadata(track, artworkUri);
      const previousMetadataPush = lastBluetoothMetadataPushRef.current;
      const metadataChanged =
        previousMetadataPush?.trackId !== track.id ||
        previousMetadataPush?.artworkUri !== (metadata.artworkUrl ?? null) ||
        previousMetadataPush?.title !== (metadata.title ?? null) ||
        previousMetadataPush?.artist !== (metadata.artist ?? null) ||
        previousMetadataPush?.albumTitle !== (metadata.albumTitle ?? null);
      await logInfo("Preparing media metadata for Android playback surfaces", {
        trackId: track.id,
        title: metadata.title ?? null,
        artist: metadata.artist ?? null,
        albumTitle: metadata.albumTitle ?? null,
        artworkUri: metadata.artworkUrl ?? null,
        artworkUriScheme: getUriScheme(metadata.artworkUrl),
        coverArtId: track.coverArtId ?? null,
        queueIndex: currentIndexRef.current,
        queueLength: queueRef.current.length,
        isPlaying: options?.isPlaying ?? null,
        hasOfflineArtwork: Boolean(getOfflineCoverUri(offlineLibraryRef.current, track.id, track.coverArtId)),
        previousMetadataPush,
        metadataChanged
      });
      await syncNativeMediaBrowserNowPlaying(track, metadata, options);
      await player.setActiveForLockScreen(true, metadata, {
        showPreviousTrack: currentIndexRef.current > 0,
        showSeekBackward: Boolean(track.bookId),
        showSeekForward: Boolean(track.bookId),
        showNextTrack: currentIndexRef.current >= 0 && currentIndexRef.current < queueRef.current.length - 1,
        showLikeButton: true,
        isLiked: likedTrackIds.has(track.id)
      } as {
        showPreviousTrack: boolean;
        showSeekBackward: boolean;
        showSeekForward: boolean;
        showNextTrack: boolean;
        showLikeButton: boolean;
        isLiked: boolean;
      });
      lastBluetoothMetadataPushRef.current = {
        trackId: track.id,
        artworkUri: metadata.artworkUrl ?? null,
        title: metadata.title ?? null,
        artist: metadata.artist ?? null,
        albumTitle: metadata.albumTitle ?? null,
        at: new Date().toISOString()
      };
      await logInfo("Android playback metadata push completed", {
        trackId: track.id,
        metadataChanged,
        artworkUri: metadata.artworkUrl ?? null,
        artworkUriScheme: getUriScheme(metadata.artworkUrl),
        isPlaying: options?.isPlaying ?? null
      });

      if (options?.isPlaying === false) {
        await player.updateLockScreenMetadata(metadata);
        await logInfo("Android playback metadata refresh issued for paused state", {
          trackId: track.id,
          artworkUri: metadata.artworkUrl ?? null,
          artworkUriScheme: getUriScheme(metadata.artworkUrl)
        });
      }
    } catch (error) {
      await logError("Lock screen state sync failed", error, {
        trackId: track.id
      });
    }
  };

  const getNativeQueuePlayer = () => playerRef.current as NativeQueueAudioPlayer | null;

  const buildNativeQueueSource = async (track: TrackRecord): Promise<NativeQueueAudioSource | null> => {
    if (!serverUrl) {
      return null;
    }

    const offlineTrackUri = getOfflineTrackUri(offlineLibraryRef.current, track.id);
    const nextUri = offlineTrackUri ?? getAbsoluteUrl(serverUrl, `/api/library/stream/${encodeURIComponent(track.id)}`);
    const artworkUrl = await resolveArtworkForMediaMetadata(track);
    const metadata = buildLockScreenMetadata(track, artworkUrl);
    await logInfo("Native queue source prepared", {
      trackId: track.id,
      title: metadata.title ?? null,
      artworkUrl: metadata.artworkUrl ?? null,
      artworkUriScheme: getUriScheme(metadata.artworkUrl),
      mediaUriScheme: getUriScheme(nextUri),
      hasAuthHeader: Boolean(token && !nextUri.startsWith("file:"))
    });

    return nextUri.startsWith("file:")
      ? {
          uri: nextUri,
          title: metadata.title,
          artist: metadata.artist,
          albumTitle: metadata.albumTitle,
          artworkUrl: metadata.artworkUrl ?? null,
          duration: track.durationSeconds ?? undefined
        }
      : {
          uri: nextUri,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          title: metadata.title,
          artist: metadata.artist,
          albumTitle: metadata.albumTitle,
          artworkUrl: metadata.artworkUrl ?? null,
          duration: track.durationSeconds ?? undefined
        };
  };

  const replaceNativeQueue = async (
    entries: QueueEntry[],
    startIndex: number,
    startPositionSeconds = 0,
    playWhenReady = true
  ) => {
    const player = getNativeQueuePlayer();

    if (!player?.replaceQueue || entries.length === 0) {
      logPlayerDebugSnapshot("Native queue replace unavailable", {
        requestedEntryCount: entries.length,
        startIndex,
        startPositionSeconds,
        playWhenReady
      });
      return false;
    }

    const sources = (await Promise.all(entries.map((entry) => buildNativeQueueSource(entry.track))))
      .filter((source): source is NativeQueueAudioSource => Boolean(source));

    if (sources.length !== entries.length) {
      logPlayerDebugSnapshot("Native queue replace skipped due to unresolved sources", {
        requestedEntryCount: entries.length,
        resolvedSourceCount: sources.length,
        startIndex
      });
      return false;
    }

    logPlayerDebugSnapshot("Native queue replace requested", {
      requestedEntryCount: entries.length,
      resolvedSourceCount: sources.length,
      startIndex,
      startPositionSeconds,
      playWhenReady,
      targetTrackId: entries[startIndex]?.track.id ?? null,
      firstArtworkUrl: sources[0]?.artworkUrl ?? null,
      targetArtworkUrl: sources[Math.max(0, Math.min(startIndex, sources.length - 1))]?.artworkUrl ?? null
    });
    player.replaceQueue(
      sources,
      Math.max(0, Math.min(startIndex, sources.length - 1)),
      Math.max(0, startPositionSeconds),
      playWhenReady
    );
    return true;
  };

  const seekNativeQueueItem = async (index: number, startPositionSeconds = 0, playWhenReady = true) => {
    const player = getNativeQueuePlayer();

    if (!player?.seekToQueueItem) {
      logPlayerDebugSnapshot("Native queue seek unavailable", {
        index,
        startPositionSeconds,
        playWhenReady
      });
      return false;
    }

    logPlayerDebugSnapshot("Native queue seek requested", {
      index,
      startPositionSeconds,
      playWhenReady,
      targetTrackId: queueRef.current[index]?.track.id ?? null
    });
    player.seekToQueueItem(index, Math.max(0, startPositionSeconds), playWhenReady);
    return true;
  };

  const syncNativeQueueAfterMutation = async (nextQueue: QueueEntry[], nextIndex: number) => {
    if (nextQueue.length === 0) {
      return;
    }

    const player = playerRef.current;
    const preservedPositionSeconds = player?.currentTime ?? playbackPosition;
    const shouldResumePlayback = player?.playing ?? isPlaying;
    await replaceNativeQueue(nextQueue, nextIndex, preservedPositionSeconds, shouldResumePlayback);
  };

  const playQueueAt = async (index: number, startingPositionSeconds?: number, queueSnapshot?: QueueEntry[]) => {
    const sourceQueue = queueSnapshot ?? queueRef.current;
    const entry = sourceQueue[index];
    const player = playerRef.current;

    if (!entry || !serverUrl || !player) {
      logPlayerDebugSnapshot("Playback start aborted", {
        requestedIndex: index,
        hasEntry: Boolean(entry),
        hasServerUrl: Boolean(serverUrl),
        hasPlayer: Boolean(player)
      });
      return;
    }

    lastHandledFinishRef.current = null;
    queueAdvanceInFlightRef.current = null;
    queueRef.current = sourceQueue;
    setQueue(sourceQueue);
    currentIndexRef.current = index;
    setCurrentIndex(index);
    setPlaybackDuration(entry.track.durationSeconds ?? 0);
    setPlaybackPosition(startingPositionSeconds ?? 0);
    setIsPlaying(true);
    lastTrackStartRef.current = {
      trackId: entry.track.id,
      index,
      at: Date.now()
    };

    void logInfo("Playback start requested", {
      index,
      queueLength: sourceQueue.length,
      trackId: entry.track.id,
      source: entry.source,
      sourceId: entry.sourceId,
      startingPositionSeconds: startingPositionSeconds ?? 0,
      nativeQueueManaged: typeof getNativeQueuePlayer()?.seekToQueueItem === "function"
    });
    scheduleAdvanceDiagnostics("playQueueAt-enter", index, entry.track.id);

    if (await seekNativeQueueItem(index, startingPositionSeconds ?? 0, true)) {
      void logInfo("Playback play() invoked", {
        index,
        trackId: entry.track.id,
        queueLength: sourceQueue.length,
        nativeQueueManaged: true
      });
      scheduleAdvanceDiagnostics("native-seek-issued", index, entry.track.id);
      await syncLockScreenState(entry.track, { isPlaying: true });
      void prefetchQueuedTrack(sourceQueue[index + 1] ?? null);
      return;
    }

    const offlineTrackUri = getOfflineTrackUri(offlineLibraryRef.current, entry.track.id);
    let cachedTrackUri: string | null = null;

    if (!offlineTrackUri && shouldCacheTrackForPlayback(entry.track)) {
      const playbackCacheUri = getPlaybackCacheUri(entry.track);
      const cachedTrackInfo = await FileSystem.getInfoAsync(playbackCacheUri).catch(() => ({ exists: false } as const));
      cachedTrackUri = cachedTrackInfo.exists ? playbackCacheUri : null;

      if (!cachedTrackUri) {
        void cacheTrackForPlayback(entry.track);
      }
    }

    const nextUri =
      offlineTrackUri ??
      cachedTrackUri ??
      getAbsoluteUrl(serverUrl, `/api/library/stream/${encodeURIComponent(entry.track.id)}`);

    logPlayerDebugSnapshot("Playback source resolved", {
      index,
      trackId: entry.track.id,
      hasOfflineTrackUri: Boolean(offlineTrackUri),
      hasCachedTrackUri: Boolean(cachedTrackUri),
      nextUriScheme: nextUri.split(":")[0] ?? "unknown"
    });

    try {
      const source = nextUri.startsWith("file:")
        ? { uri: nextUri }
        : {
            uri: nextUri,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined
          };
      logPlayerDebugSnapshot("Playback replace requested", {
        index,
        trackId: entry.track.id,
        startingPositionSeconds: startingPositionSeconds ?? 0,
        isOffline: nextUri.startsWith("file:")
      });
      player.replace(source);

      if (startingPositionSeconds && startingPositionSeconds > 0) {
        await player.seekTo(Math.max(0, startingPositionSeconds));
      } else {
        await player.seekTo(0);
      }
      logPlayerDebugSnapshot("Playback seek completed", {
        index,
        trackId: entry.track.id,
        startingPositionSeconds: startingPositionSeconds ?? 0
      });

      player.play();
      void logInfo("Playback play() invoked", {
        index,
        trackId: entry.track.id,
        queueLength: sourceQueue.length,
        isOffline: nextUri.startsWith("file:"),
        nativeQueueManaged: false
      });
      scheduleAdvanceDiagnostics("js-play-issued", index, entry.track.id);

      setTimeout(() => {
        if (!playerRef.current || currentIndexRef.current !== index) {
          logPlayerDebugSnapshot("Playback retry skipped", {
            index,
            trackId: entry.track.id,
            retryReason: !playerRef.current ? "missing-player" : "index-changed"
          });
          return;
        }

        if (!playerRef.current.playing) {
          playerRef.current.play();
          setIsPlaying(true);
          void logInfo("Playback play() retried after delayed start", {
            index,
            trackId: entry.track.id,
            queueLength: sourceQueue.length
          });
          scheduleAdvanceDiagnostics("js-play-retried", index, entry.track.id);
        } else {
          logPlayerDebugSnapshot("Playback retry not needed", {
            index,
            trackId: entry.track.id
          });
        }
      }, 220);

      await syncLockScreenState(entry.track, { isPlaying: true });
      void prefetchQueuedTrack(sourceQueue[index + 1] ?? null);
    } catch (error) {
      queueAdvanceInFlightRef.current = null;
      setIsPlaying(false);
      await logError("Playback start failed", error, {
        trackId: entry.track.id,
        sourceId: entry.sourceId,
        isOffline: nextUri.startsWith("file:")
      });
    }
  };

  const enqueueAndPlay = async (
    nextTracks: TrackRecord[],
    source: QueueSource,
    sourceId: string | null,
    startIndex = 0,
    startPositionSeconds?: number,
    preserveOrder = false
  ) => {
    const orderedTracks = (preserveOrder ? nextTracks : sortTracksByOrder(nextTracks)).map((track) => ({
      track,
      source,
      sourceId
    }));

    if ((source === "album" || source === "book" || source === "playlist") && sourceId) {
      await persistLastListenedEntity({
        kind: source,
        id: sourceId,
        updatedAt: new Date().toISOString()
      });
    }

    await logInfo("Queue replaced and playback enqueued", {
      source,
      sourceId,
      requestedTrackCount: nextTracks.length,
      queueLength: orderedTracks.length,
      startIndex,
      preserveOrder,
      startTrackId: orderedTracks[startIndex]?.track.id ?? orderedTracks[0]?.track.id ?? null
    });

    queueRef.current = orderedTracks;
    currentIndexRef.current = startIndex;
    setQueue(orderedTracks);
    setCurrentIndex(startIndex);
    setPlaybackPosition(startPositionSeconds ?? 0);
    setPlaybackDuration(orderedTracks[startIndex]?.track.durationSeconds ?? 0);
    setIsPlaying(true);

    if (await replaceNativeQueue(orderedTracks, startIndex, startPositionSeconds ?? 0, true)) {
      const startEntry = orderedTracks[startIndex] ?? orderedTracks[0] ?? null;
      if (startEntry) {
        await logInfo("Native playback queue loaded", {
          queueLength: orderedTracks.length,
          startIndex,
          startTrackId: startEntry.track.id
        });
        await syncLockScreenState(startEntry.track, { isPlaying: true });
        void prefetchQueuedTrack(orderedTracks[startIndex + 1] ?? null);
      }
      return;
    }

    await playQueueAt(startIndex, startPositionSeconds, orderedTracks);
  };

  const insertTrackNextInQueue = async (track: TrackRecord, source: QueueSource, sourceId: string | null) => {
    if (!currentTrack || currentIndexRef.current < 0 || queueRef.current.length === 0) {
      await enqueueAndPlay([track], source, sourceId, 0, undefined, true);
      return;
    }

    const nextQueue = [...queueRef.current];
    nextQueue.splice(currentIndexRef.current + 1, 0, { track, source, sourceId });
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    await syncNativeQueueAfterMutation(nextQueue, currentIndexRef.current);
  };

  const appendTrackToQueue = async (track: TrackRecord, source: QueueSource, sourceId: string | null) => {
    if (!currentTrack || currentIndexRef.current < 0 || queueRef.current.length === 0) {
      await enqueueAndPlay([track], source, sourceId, 0, undefined, true);
      return;
    }

    const nextQueue = [...queueRef.current, { track, source, sourceId }];
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    await syncNativeQueueAfterMutation(nextQueue, currentIndexRef.current);
  };

  const appendSelectionToQueue = async (
    nextTracks: TrackRecord[],
    source: QueueSource,
    sourceId: string | null,
    preserveOrder = false
  ) => {
    const orderedTracks = preserveOrder ? [...nextTracks] : sortTracksByOrder(nextTracks);

    if (orderedTracks.length === 0) {
      return;
    }

    if (!currentTrack || currentIndexRef.current < 0 || queueRef.current.length === 0) {
      await enqueueAndPlay(orderedTracks, source, sourceId, 0, undefined, true);
      return;
    }

    const nextEntries = orderedTracks.map((queuedTrack) => ({
      track: queuedTrack,
      source,
      sourceId
    }));
    const nextQueue = [...queueRef.current, ...nextEntries];
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    await syncNativeQueueAfterMutation(nextQueue, currentIndexRef.current);
  };

  const moveQueueEntry = async (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= queueRef.current.length || toIndex >= queueRef.current.length) {
      return;
    }

    const nextQueue = [...queueRef.current];
    const [movedEntry] = nextQueue.splice(fromIndex, 1);

    if (!movedEntry) {
      return;
    }

    nextQueue.splice(toIndex, 0, movedEntry);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    await syncNativeQueueAfterMutation(nextQueue, currentIndexRef.current);
  };

  const removeQueueEntry = async (indexToRemove: number) => {
    if (indexToRemove < 0 || indexToRemove >= queueRef.current.length) {
      return;
    }

    const nextQueue = queueRef.current.filter((_, index) => index !== indexToRemove);
    queueRef.current = nextQueue;
    setQueue(nextQueue);

    if (currentIndexRef.current >= nextQueue.length) {
      currentIndexRef.current = nextQueue.length - 1;
      setCurrentIndex(nextQueue.length - 1);
      void syncNativeQueueAfterMutation(nextQueue, nextQueue.length - 1);
      return;
    }

    if (indexToRemove < currentIndexRef.current) {
      currentIndexRef.current -= 1;
      setCurrentIndex(currentIndexRef.current);
    }

    void syncNativeQueueAfterMutation(nextQueue, currentIndexRef.current);
  };

  const togglePlayback = async () => {
    const player = playerRef.current;

    if (!player) {
      return;
    }

    if (player.playing) {
      const currentBookProgress = getPersistableBookProgress(currentTrack);
      if (currentBookProgress) {
        applyBookProgressToState(currentBookProgress.bookId, currentBookProgress);
        await persistLocalBookProgress(currentBookProgress.bookId, {
          trackId: currentBookProgress.trackId,
          positionSeconds: currentBookProgress.positionSeconds,
          updatedAt: currentBookProgress.updatedAt
        });
      }
      player.pause();
      if (currentTrack) {
        await syncLockScreenState(currentTrack, { isPlaying: false });
      }
      return;
    }

    player.play();
    if (currentTrack) {
      await syncLockScreenState(currentTrack, { isPlaying: true });
    }
  };

  const seekCurrentTrackBy = async (deltaSeconds: number) => {
    const player = playerRef.current;

    if (!player || !currentTrack?.bookId) {
      return;
    }

    const nextPositionSeconds = Math.max(0, Math.min(player.duration || playbackDuration, player.currentTime + deltaSeconds));
    lastExplicitSeekRef.current = {
      trackId: currentTrack.id,
      positionSeconds: nextPositionSeconds,
      at: Date.now()
    };
    rememberBookProgress(currentTrack, nextPositionSeconds);
    setPlaybackPosition(nextPositionSeconds);
    await player.seekTo(nextPositionSeconds);
  };

  const seekCurrentTrackTo = async (positionSeconds: number) => {
    const player = playerRef.current;

    if (!player || !currentTrack) {
      return;
    }

    const boundedPositionSeconds = Math.max(0, Math.min(player.duration || playbackDuration, positionSeconds));
    if (currentTrack.bookId) {
      lastExplicitSeekRef.current = {
        trackId: currentTrack.id,
        positionSeconds: boundedPositionSeconds,
        at: Date.now()
      };
      rememberBookProgress(currentTrack, boundedPositionSeconds);
    }
    setPlaybackPosition(boundedPositionSeconds);
    await player.seekTo(boundedPositionSeconds);
  };

  const expandedPlayerTranslateY = useRef(new Animated.Value(0)).current;
  const expandedPlayerDismissResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        gestureState.dy > 4 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
        gestureState.dy > 2 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        expandedPlayerTranslateY.stopAnimation();
      },
      onPanResponderMove: (_event, gestureState) => {
        expandedPlayerTranslateY.setValue(Math.max(0, gestureState.dy));
      },
      onPanResponderRelease: (_event, gestureState) => {
        const shouldClose = gestureState.dy > 72 || gestureState.vy > 1.05;

        if (shouldClose) {
          Animated.timing(expandedPlayerTranslateY, {
            toValue: Math.max(140, gestureState.dy + 80),
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true
          }).start(() => {
            expandedPlayerTranslateY.setValue(0);
            setMobilePlayerExpanded(false);
          });
          return;
        }
        Animated.spring(expandedPlayerTranslateY, {
          toValue: 0,
          stiffness: 240,
          damping: 26,
          mass: 0.9,
          useNativeDriver: true
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(expandedPlayerTranslateY, {
          toValue: 0,
          stiffness: 240,
          damping: 26,
          mass: 0.9,
          useNativeDriver: true
        }).start();
      }
    })
  ).current;

  useEffect(() => {
    if (!mobilePlayerExpanded) {
      expandedPlayerTranslateY.setValue(0);
    }
  }, [expandedPlayerTranslateY, mobilePlayerExpanded]);

  const openAlbum = async (albumId: string) => {
    setBusy(true);
    setCurrentItem({ type: "album", id: albumId });
    setView("library");
    setLibraryMode("albums");
    setBookServerProgress(null);

    try {
      setAlbumDetail(await fetchAlbumDetail(apiOptions, albumId));
      setBookDetail(null);
    } catch (error) {
      const offlineDetail = buildOfflineAlbumDetail(albumId);

      if (offlineDetail) {
        setAlbumDetail(offlineDetail);
        setBookDetail(null);
        await logInfo("Album opened from offline bundle", {
          albumId,
          trackCount: offlineDetail.tracks.length
        });
      } else {
        await logError("Album detail load failed", error, { albumId });
      }
    } finally {
      setBusy(false);
    }
  };

  const openBook = async (bookId: string) => {
    const offlineDetail = buildOfflineBookDetail(bookId);
    const hasImmediateOfflineDetail = Boolean(offlineDetail);

    setBusy(!hasImmediateOfflineDetail);
    setCurrentItem({ type: "book", id: bookId });
    setView("library");
    setLibraryMode("books");
    setAlbumDetail(null);

    if (offlineDetail) {
      try {
        const persistedProgress = await readPersistedBookProgress();
        setBookServerProgress(null);
        setBookDetail(mergeBookProgress(offlineDetail, persistedProgress[bookId] ?? null));
        await logInfo("Book opened from offline bundle immediately", {
          bookId,
          trackCount: offlineDetail.tracks.length,
          hasPersistedProgress: Boolean(persistedProgress[bookId])
        });
      } catch (error) {
        await logError("Immediate offline book detail load failed", error, { bookId });
      }
    }

    try {
      const [serverDetail, persistedProgress] = await Promise.all([
        fetchBookDetail(apiOptions, bookId),
        readPersistedBookProgress()
      ]);
      setBookServerProgress(serverDetail.progress ?? null);
      setBookDetail(mergeBookProgress(serverDetail, persistedProgress[bookId] ?? null));
      await logInfo("Book detail refreshed from server", {
        bookId,
        trackCount: serverDetail.tracks.length,
        hasServerProgress: Boolean(serverDetail.progress)
      });
    } catch (error) {
      if (offlineDetail) {
        const persistedProgress = await readPersistedBookProgress();
        setBookServerProgress(null);
        setBookDetail(mergeBookProgress(offlineDetail, persistedProgress[bookId] ?? null));
        await logInfo("Book opened from offline bundle after server fetch failed", {
          bookId,
          trackCount: offlineDetail.tracks.length
        });
      } else {
        await logError("Book detail load failed", error, { bookId });
      }
    } finally {
      setBusy(false);
    }
  };

  const openPlaylist = (playlistId: string) => {
    const offlineDetail = buildOfflinePlaylistDetail(playlistId);
    setCurrentItem({ type: "playlist", id: playlistId });
    setAlbumDetail(null);
    setBookDetail(null);
    setBookServerProgress(null);
    if (offlineDetail) {
      setPlaylists((previous) => {
        const nextPlaylists = [...previous];
        const playlistIndex = nextPlaylists.findIndex((playlist) => playlist.id === playlistId);

        if (playlistIndex >= 0) {
          nextPlaylists[playlistIndex] = {
            ...nextPlaylists[playlistIndex]!,
            tracks: offlineDetail.tracks,
            trackCount: offlineDetail.trackCount
          };
          return nextPlaylists;
        }

        return [offlineDetail, ...previous];
      });
    }
    setView("library");
    setLibraryMode("playlists");
  };

  const persistCredentials = async (nextUrl: string, nextToken: string) => {
    await Promise.all([
      AsyncStorage.setItem(SERVER_URL_KEY, nextUrl),
      AsyncStorage.setItem(SESSION_TOKEN_KEY, nextToken)
    ]);
  };

  const resetSavedSession = async (reason?: string) => {
    await AsyncStorage.removeItem(SESSION_TOKEN_KEY);
    setToken(null);
    setAlbumDetail(null);
    setBookDetail(null);
    setBookServerProgress(null);
    setCurrentItem(null);
    setQueue([]);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setPlaybackPosition(0);
    setPlaybackDuration(0);
    setAuthPassword("");
    setBusy(false);

    if (reason) {
      setAuthError(reason);
    }

    await logInfo("Saved mobile session reset", {
      reason: reason ?? "manual"
    });
  };

  const handleAuthSubmit = async () => {
    setAuthError(null);
    setBusy(true);

    try {
      const nextServerUrl = serverUrl.trim().replace(/\/+$/, "");
      await logInfo("Authentication request started", {
        mode: authMode,
        serverUrl: nextServerUrl
      });
      await probeServer(nextServerUrl);
      const session =
        authMode === "register"
          ? await registerFirstUser(nextServerUrl, {
              name: authName,
              email: authEmail,
              password: authPassword
            })
          : await loginUser(nextServerUrl, {
              email: authEmail,
              password: authPassword
            });

      await persistCredentials(nextServerUrl, session.token);
      setServerUrl(nextServerUrl);
      setToken(session.token);
      setBusy(false);
      showStatusNotice("Signed in. Loading cached library while the server refresh runs.");
      await logInfo("Authentication succeeded", {
        mode: authMode,
        serverUrl: nextServerUrl
      });
    } catch (error) {
      await logError("Authentication failed", error, {
        mode: authMode,
        serverUrl: serverUrl.trim()
      });
      setAuthError(error instanceof Error ? error.message : "Authentication failed");
      setBusy(false);
    }
  };

  const syncBundle = (kind: SyncKind, id: string) => {
    if (!token) {
      return;
    }

    const bundleKey = getRequestKey(kind, id);
    setSyncErrors((previous) => {
      if (!(bundleKey in previous)) {
        return previous;
      }

      const next = { ...previous };
      delete next[bundleKey];
      return next;
    });
    const isQueued = syncQueue.some((request) => getRequestKey(request.kind, request.id) === bundleKey);

    if (syncingKey === bundleKey || isQueued) {
      return;
    }

    if (syncingKey) {
      setSyncProgress((previous) => ({
        ...previous,
        [bundleKey]: {
          completedTracks: 0,
          totalTracks: 0,
          fraction: 0
        }
      }));
      setSyncQueue((previous) => [...previous, { kind, id }]);
      return;
    }

    void runSyncRequest({ kind, id });
  };

  const removeBundle = async (kind: SyncKind, id: string) => {
    try {
      const nextLibrary = await removeOfflineBundle(offlineLibraryRef.current, `${kind}:${id}`);
      offlineLibraryRef.current = nextLibrary;
      setOfflineLibrary(nextLibrary);
      await logInfo("Offline bundle removed", { kind, id });
    } catch (error) {
      await logError("Offline bundle removal failed", error, { kind, id });
    }
  };

  const promptRemoveBundle = (kind: SyncKind, id: string) => {
    Alert.alert("Remove offline copy?", "This will delete the synced files from this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          void removeBundle(kind, id);
        }
      }
    ]);
  };

  const restartBookFromBeginning = (detail: BookDetailRecord) => {
    const orderedTracks = sortTracksByOrder(detail.tracks);
    const firstTrack = orderedTracks[0];

    if (!firstTrack) {
      return;
    }

    Alert.alert(
      "Restart book?",
      "This will restart the book from the beginning and clear your saved bookmark position.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restart",
          style: "destructive",
          onPress: () => {
            void (async () => {
              const updatedAt = new Date().toISOString();
              const resetProgress = {
                bookId: detail.book.id,
                trackId: firstTrack.id,
                positionSeconds: 0,
                updatedAt
              };

              try {
                await persistLocalBookProgress(detail.book.id, resetProgress);

                if (serverUrl && token) {
                  const response = await saveBookProgress(apiOptions, detail.book.id, {
                    trackId: firstTrack.id,
                    positionSeconds: 0
                  });
                  setBookServerProgress(
                    response.progress
                      ? {
                          bookId: detail.book.id,
                          ...response.progress
                        }
                      : null
                  );
                } else {
                  setBookServerProgress(resetProgress);
                }
              } catch (error) {
                await logError("Book restart progress reset failed", error, {
                  bookId: detail.book.id,
                  firstTrackId: firstTrack.id
                });
                showStatusNotice("Could not reset the saved bookmark. Restarting from the beginning anyway.");
              }

              setBookDetail((previous) =>
                previous && previous.book.id === detail.book.id
                  ? {
                      ...previous,
                      progress: resetProgress
                    }
                  : previous
              );
              setBooks((previous) =>
                previous.map((book) =>
                  book.id === detail.book.id
                    ? {
                        ...book,
                        lastTrackId: firstTrack.id,
                        lastPositionSeconds: 0,
                        lastListenedAt: updatedAt
                      }
                    : book
                )
              );

              await enqueueAndPlay(orderedTracks, "book", detail.book.id, 0, 0);
            })();
          }
        }
      ]
    );
  };

  const markBookAsRead = (detail: BookDetailRecord) => {
    const orderedTracks = sortTracksByOrder(detail.tracks);
    const lastTrack = orderedTracks[orderedTracks.length - 1];

    if (!lastTrack) {
      return;
    }

    void (async () => {
      const updatedAt = new Date().toISOString();
      const completedProgress = {
        bookId: detail.book.id,
        trackId: lastTrack.id,
        positionSeconds: Math.max(0, lastTrack.durationSeconds ?? 0),
        updatedAt
      };

      try {
        applyBookProgressToState(detail.book.id, completedProgress);
        await persistLocalBookProgress(detail.book.id, completedProgress);

        if (serverUrl && token) {
          const response = await saveBookProgress(apiOptions, detail.book.id, {
            trackId: lastTrack.id,
            positionSeconds: completedProgress.positionSeconds
          });
          setBookServerProgress(
            response.progress
              ? {
                  bookId: detail.book.id,
                  ...response.progress
                }
              : completedProgress
          );
        } else {
          setBookServerProgress(completedProgress);
        }

        showStatusNotice("Book marked as read.");
      } catch (error) {
        await logError("Mark book as read failed", error, {
          bookId: detail.book.id,
          lastTrackId: lastTrack.id
        });
        showStatusNotice("Could not mark the book as read.");
      }
    })();
  };

  const onSelectTrack = async (track: TrackRecord, source: QueueSource, sourceId: string | null, allTracks: TrackRecord[]) => {
    const orderedTracks = source === "playlist" ? [...allTracks] : sortTracksByOrder(allTracks);
    const index = orderedTracks.findIndex((item) => item.id === track.id);
    await logInfo("Track selected for playback", {
      trackId: track.id,
      source,
      sourceId,
      visibleTrackCount: allTracks.length,
      queueLength: orderedTracks.length,
      selectedIndex: Math.max(index, 0)
    });
    await enqueueAndPlay(orderedTracks, source, sourceId, Math.max(index, 0), undefined, true);
  };

  const playTrackFromBrowserSource = async (source: string, sourceId: string, trackId: string) => {
    if (source === "playlist") {
      const playlist = playlists.find((entry) => entry.id === sourceId);
      const playlistTracks = playlist?.tracks ?? [];
      const track = playlistTracks.find((entry) => entry.id === trackId);

      if (track) {
        await onSelectTrack(track, "playlist", sourceId, playlistTracks);
      }
      return;
    }

    const sourceTracks = tracks.filter((entry) => {
      if (source === "album") {
        return entry.albumId === sourceId;
      }
      if (source === "book") {
        return entry.bookId === sourceId;
      }
      if (source === "artist") {
        return entry.artistId === sourceId;
      }
      return false;
    });
    const track = sourceTracks.find((entry) => entry.id === trackId);

    if (!track) {
      return;
    }

    const queueSource: QueueSource = source === "book" ? "book" : source === "artist" ? "search" : "album";
    await onSelectTrack(track, queueSource, sourceId, sourceTracks);
  };

  useEffect(() => {
    const maybePersistBookProgress = async () => {
      const currentBookProgress = getPersistableBookProgress(currentTrack);

      if (!token || !currentBookProgress || currentIndex < 0) {
        return;
      }

       const roundedPositionSeconds = Math.floor(currentBookProgress.positionSeconds);
       const localCheckpoint = Math.floor(roundedPositionSeconds / 5);
       if (
         !lastLocalBookProgressSaveRef.current ||
         lastLocalBookProgressSaveRef.current.bookId !== currentBookProgress.bookId ||
         lastLocalBookProgressSaveRef.current.checkpoint !== localCheckpoint
       ) {
         applyBookProgressToState(currentBookProgress.bookId, currentBookProgress);
         await persistLocalBookProgress(currentBookProgress.bookId, {
           trackId: currentBookProgress.trackId,
           positionSeconds: currentBookProgress.positionSeconds,
           updatedAt: currentBookProgress.updatedAt
         });
         lastLocalBookProgressSaveRef.current = {
           bookId: currentBookProgress.bookId,
           checkpoint: localCheckpoint
         };
       }

      const serverCheckpoint = Math.floor(roundedPositionSeconds / 30);
      if (
        roundedPositionSeconds < 30 ||
        (lastServerBookProgressSaveRef.current?.bookId === currentBookProgress.bookId &&
          lastServerBookProgressSaveRef.current.checkpoint === serverCheckpoint)
      ) {
        return;
      }

      try {
        await saveBookProgress(apiOptions, currentBookProgress.bookId, {
          trackId: currentBookProgress.trackId,
          positionSeconds: currentBookProgress.positionSeconds
        });
        lastServerBookProgressSaveRef.current = {
          bookId: currentBookProgress.bookId,
          checkpoint: serverCheckpoint
        };
      } catch (error) {
        await logError("Book progress save failed", error, {
          bookId: currentBookProgress.bookId,
          trackId: currentBookProgress.trackId
        });
      }
    };

    void maybePersistBookProgress();
  }, [apiOptions, currentIndex, currentTrack, playbackPosition, token]);

  useEffect(() => {
    const persistOnPauseOrSwitch = async () => {
      const currentBookProgress = getPersistableBookProgress(currentTrack);

      if (!currentBookProgress) {
        return;
      }

      applyBookProgressToState(currentBookProgress.bookId, currentBookProgress);
      await persistLocalBookProgress(currentBookProgress.bookId, {
        trackId: currentBookProgress.trackId,
        positionSeconds: currentBookProgress.positionSeconds,
        updatedAt: currentBookProgress.updatedAt
      });
    };

    if (!isPlaying) {
      void persistOnPauseOrSwitch();
    }

    return () => {
      void persistOnPauseOrSwitch();
    };
  }, [currentTrack?.id, currentTrack?.bookId, isPlaying, playbackPosition]);

  const heroAlbum = visibleAlbums.find((album) => album.id === featuredAlbumId) ?? visibleAlbums[0] ?? null;
  const featuredBook = visibleBooks.find((book) => book.id === featuredBookId) ?? null;
  const featuredPlaylist = fallbackVisiblePlaylists.find((playlist) => playlist.id === featuredPlaylistId) ?? null;
  const featuredArtist = allArtists.find((artist) => artist.id === featuredArtistId) ?? null;
  const homeHero = useMemo(() => {
    const continueAlbum =
      lastListenedEntity?.kind === "album"
        ? visibleAlbums.find((album) => album.id === lastListenedEntity.id) ?? null
        : null;
    if (continueAlbum) {
      return {
        eyebrow: "Continue Listening",
        title: continueAlbum.name,
        subtitle: `${continueAlbum.artist} Â· ${continueAlbum.songCount} tracks`,
        remoteUri: getCoverRemoteUri(continueAlbum.coverArtId),
        offlineUri: offlineLibrary.bundles[`album:${continueAlbum.id}`]?.coverUri ?? null,
        primaryLabel: "Open Album",
        onPrimaryPress: () => void openAlbum(continueAlbum.id),
        syncStatus: getBundleVisualState("album", continueAlbum.id),
        onSyncPress: () => void syncBundle("album", continueAlbum.id)
      } as const;
    }

    const continueBook =
      lastListenedEntity?.kind === "book"
        ? visibleBooks.find((book) => book.id === lastListenedEntity.id) ?? null
        : null;
    if (continueBook) {
      return {
        eyebrow: "Continue Listening",
        title: continueBook.title,
        subtitle: `${continueBook.author} Â· ${continueBook.trackCount} chapters`,
        remoteUri: getCoverRemoteUri(continueBook.coverArtId),
        offlineUri: offlineLibrary.bundles[`book:${continueBook.id}`]?.coverUri ?? null,
        primaryLabel: "Open Book",
        onPrimaryPress: () => void openBook(continueBook.id),
        syncStatus: getBundleVisualState("book", continueBook.id),
        onSyncPress: () => void syncBundle("book", continueBook.id)
      } as const;
    }

    const continuePlaylist =
      lastListenedEntity?.kind === "playlist"
        ? fallbackVisiblePlaylists.find((playlist) => playlist.id === lastListenedEntity.id) ?? null
        : null;
    if (continuePlaylist) {
      return {
        eyebrow: "Continue Listening",
        title: continuePlaylist.name,
        subtitle: getPlaylistDisplaySubtitle(continuePlaylist),
        remoteUri: getCoverRemoteUri(continuePlaylist.coverArtId),
        offlineUri: offlineLibrary.bundles[`playlist:${continuePlaylist.id}`]?.coverUri ?? null,
        primaryLabel: "Open Playlist",
        onPrimaryPress: () => openPlaylist(continuePlaylist.id),
        syncStatus: isSmartPlaylistRecord(continuePlaylist) ? undefined : getBundleVisualState("playlist", continuePlaylist.id),
        onSyncPress: isSmartPlaylistRecord(continuePlaylist) ? undefined : () => void syncBundle("playlist", continuePlaylist.id)
      } as const;
    }

    if (heroAlbum) {
      return {
        eyebrow: "Featured Album",
        title: heroAlbum.name,
        subtitle: `${heroAlbum.artist} Â· ${heroAlbum.songCount} tracks`,
        remoteUri: getCoverRemoteUri(heroAlbum.coverArtId),
        offlineUri: offlineLibrary.bundles[`album:${heroAlbum.id}`]?.coverUri ?? null,
        primaryLabel: "Open Album",
        onPrimaryPress: () => void openAlbum(heroAlbum.id),
        syncStatus: getBundleVisualState("album", heroAlbum.id),
        onSyncPress: () => void syncBundle("album", heroAlbum.id)
      } as const;
    }

    if (featuredBook) {
      return {
        eyebrow: "Featured Book",
        title: featuredBook.title,
        subtitle: `${featuredBook.author} Â· ${featuredBook.trackCount} chapters`,
        remoteUri: getCoverRemoteUri(featuredBook.coverArtId),
        offlineUri: offlineLibrary.bundles[`book:${featuredBook.id}`]?.coverUri ?? null,
        primaryLabel: "Open Book",
        onPrimaryPress: () => void openBook(featuredBook.id),
        syncStatus: getBundleVisualState("book", featuredBook.id),
        onSyncPress: () => void syncBundle("book", featuredBook.id)
      } as const;
    }

    if (featuredPlaylist) {
      return {
        eyebrow: "Featured Playlist",
        title: featuredPlaylist.name,
        subtitle: getPlaylistDisplaySubtitle(featuredPlaylist),
        remoteUri: getCoverRemoteUri(featuredPlaylist.coverArtId),
        offlineUri: offlineLibrary.bundles[`playlist:${featuredPlaylist.id}`]?.coverUri ?? null,
        primaryLabel: "Open Playlist",
        onPrimaryPress: () => openPlaylist(featuredPlaylist.id),
        syncStatus: isSmartPlaylistRecord(featuredPlaylist) ? undefined : getBundleVisualState("playlist", featuredPlaylist.id),
        onSyncPress: isSmartPlaylistRecord(featuredPlaylist) ? undefined : () => void syncBundle("playlist", featuredPlaylist.id)
      } as const;
    }

    return null;
  }, [
    featuredBook,
    featuredPlaylist,
    getBundleVisualState,
    getCoverRemoteUri,
    heroAlbum,
    lastListenedEntity,
    offlineLibrary.bundles,
    openAlbum,
    openBook,
    openPlaylist,
    syncBundle,
    visibleAlbums,
    visibleBooks,
    fallbackVisiblePlaylists
  ]);
  const albumCardItems = safeMap(filteredAlbums, (album) => ({
        key: album.id,
        title: album.name,
        subtitle: `${album.artist} · ${formatDuration(album.durationSeconds)}`,
        accent: null,
        artCornerIcon: getBundleVisualState("album", album.id) === "synced"
          ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
          : undefined,
        artCornerIconAlign: "right" as const,
        remoteUri: getCoverRemoteUri(album.coverArtId),
        offlineUri: offlineLibrary.bundles[`album:${album.id}`]?.coverUri ?? null,
        onPress: () => void openAlbum(album.id)
      }), "albumCardItems");
  const artistCardItems = safeMap(filteredArtists, (artist) => ({
        key: artist.id,
        title: artist.name,
        subtitle: `${artist.albumCount} albums · ${artist.totalTracks} tracks`,
        accent: "Artist",
        remoteUri: getCoverRemoteUri(artist.coverArtId),
        offlineUri: artist.coverUri,
        onPress: () => openArtist(artist.id)
      }), "artistCardItems");
  const recentBooks = visibleBooks.slice(0, 4);
  const recentArtists = filteredArtists.slice(0, 4);
  const recentPlaylists = fallbackVisiblePlaylists.slice(0, 4);
  const mobileBottomInset = Math.max(insets.bottom, 10);
  const mobileNavHeight = 74 + mobileBottomInset;
  const expandedQueueHeight = Math.min(6, upcomingQueueEntries.length) * 58;
  const mobilePlayerHeight = currentTrack ? (mobilePlayerExpanded ? 252 + expandedQueueHeight : 60) : 0;
  const mobileDockHeight = mobileNavHeight + mobilePlayerHeight + 12;
  const showVirtualizedAlbumBrowser = !busy && view === "library" && libraryMode === "albums" && (!currentItem || currentItem.type !== "album");
  const showVirtualizedArtistBrowser = !busy && view === "library" && libraryMode === "artists" && (!currentItem || currentItem.type !== "artist");
  const albumGridColumns = isTablet ? 3 : 2;
  const syncedBundles = safeMap(Object.entries(offlineLibrary.bundles), ([key, bundle]) => ({ key, bundle }), "syncedBundles")
    .sort((left, right) => right.bundle.syncedAt.localeCompare(left.bundle.syncedAt));
  const currentDownloadEntry = syncingKey
    ? (() => {
        const request = parseBundleKey(syncingKey);
        const summary = getBundleSummary(request.kind, request.id);
        const progress = syncProgress[syncingKey];
        return {
          key: syncingKey,
          title: summary.title,
          subtitle: progress
            ? `${summary.subtitle} · ${progress.completedTracks}/${progress.totalTracks} tracks · ${Math.round(progress.fraction * 100)}%`
            : summary.subtitle,
          status: "syncing" as const
        };
      })()
    : null;
  const queuedDownloadEntries = safeMap(syncQueue, (request) => {
    const summary = getBundleSummary(request.kind, request.id);
    return {
      key: `${request.kind}:${request.id}`,
      title: summary.title,
      subtitle: summary.subtitle,
      status: "queued" as const
    };
  }, "queuedDownloadEntries");
  const syncedDownloadEntries = safeMap(syncedBundles, ({ key, bundle }) => ({
    key,
    title: bundle.title,
    subtitle: bundle.subtitle,
    status: "synced" as const
  }), "syncedDownloadEntries");
  const downloadEntries = [currentDownloadEntry, ...queuedDownloadEntries, ...syncedDownloadEntries].filter(Boolean) as Array<{
    key: string;
    title: string;
    subtitle: string;
    status: "syncing" | "queued" | "synced";
  }>;
  const searchResults = [
    ...safeMap(filteredAlbums, (album) => ({
      key: `album:${album.id}`,
      kind: "album" as const,
      label: album.name,
      meta: album.artist,
      id: album.id,
      remoteUri: getCoverRemoteUri(album.coverArtId),
      offlineUri: offlineLibrary.bundles[`album:${album.id}`]?.coverUri ?? null
    }), "searchResults.albums"),
    ...safeMap(filteredBooks, (book) => ({
      key: `book:${book.id}`,
      kind: "book" as const,
      label: book.title,
      meta: book.author,
      id: book.id,
      remoteUri: getCoverRemoteUri(book.coverArtId),
      offlineUri: offlineLibrary.bundles[`book:${book.id}`]?.coverUri ?? null
    }), "searchResults.books"),
    ...safeMap(filteredPlaylists, (playlist) => ({
      key: `playlist:${playlist.id}`,
      kind: "playlist" as const,
      label: playlist.name,
      meta: `${playlist.trackCount} tracks`,
      id: playlist.id,
      remoteUri: getCoverRemoteUri(playlist.coverArtId),
      offlineUri: offlineLibrary.bundles[`playlist:${playlist.id}`]?.coverUri ?? null
    }), "searchResults.playlists")
  ].slice(0, 14);

  function getCoverRemoteUri(coverArtId: string | null) {
    if (!coverArtId) {
      return null;
    }

    return getAbsoluteUrl(
      serverUrl,
      `/api/library/cover-art/${encodeURIComponent(coverArtId)}?variant=mobile&rev=${encodeURIComponent(coverArtRefreshKey)}`
    );
  }
  const artistHeaderAlbum = artistAlbums[0] ?? null;
  const artistHeaderBook = artistBooks[0] ?? null;
  const artistHeaderRemoteUri = getCoverRemoteUri(artistHeaderAlbum?.coverArtId ?? artistHeaderBook?.coverArtId ?? null);
  const artistHeaderOfflineUri =
    (artistHeaderAlbum ? offlineLibrary.bundles[`album:${artistHeaderAlbum.id}`]?.coverUri : null) ??
    (artistHeaderBook ? offlineLibrary.bundles[`book:${artistHeaderBook.id}`]?.coverUri : null) ??
    null;

  function getRequestKey(kind: SyncKind, id: string) {
    return `${kind}:${id}`;
  }
  function parseBundleKey(bundleKey: string): SyncRequest {
    const [kind, ...idParts] = bundleKey.split(":");
    return {
      kind: (kind === "album" || kind === "book" || kind === "playlist" ? kind : "album") as SyncKind,
      id: idParts.join(":")
    };
  }

  function getBundleSummary(kind: SyncKind, id: string) {
    if (kind === "album") {
      const album = visibleAlbums.find((item) => item.id === id);
      return {
        title: album?.name ?? "Album",
        subtitle: album ? `${album.artist} · ${album.songCount} tracks` : "Album sync"
      };
    }

    if (kind === "playlist") {
      const playlist = visiblePlaylists.find((item) => item.id === id);
      return {
        title: playlist?.name ?? "Playlist",
        subtitle: playlist ? `${playlist.trackCount} tracks` : "Playlist sync"
      };
    }

    const book = visibleBooks.find((item) => item.id === id);
    return {
      title: book?.title ?? "Book",
      subtitle: book ? `${book.author} · ${book.trackCount} chapters` : "Book sync"
    };
  }

  function getBundleVisualState(kind: SyncKind, id: string): SyncVisualState {
    const bundleKey = getRequestKey(kind, id);

    if (offlineLibrary.bundles[bundleKey]) {
      return "synced";
    }

    if (syncingKey === bundleKey) {
      return "syncing";
    }

    if (syncQueue.some((request) => getRequestKey(request.kind, request.id) === bundleKey)) {
      return "queued";
    }

    if (syncErrors[bundleKey]) {
      return "error";
    }

    return "idle";
  }

  function getBundleStatusLabel(kind: SyncKind, id: string) {
    const bundleKey = getRequestKey(kind, id);
    const visualState = getBundleVisualState(kind, id);
    const progress = syncProgress[bundleKey];

    if (visualState === "syncing" && progress) {
      const percentage = Math.round(progress.fraction * 100);
      return `Downloading ${progress.completedTracks}/${progress.totalTracks} tracks (${percentage}%)`;
    }

    if (visualState === "queued") {
      return "Queued for download";
    }

    if (visualState === "synced") {
      return "Available offline";
    }

    if (visualState === "error") {
      return syncErrors[bundleKey];
    }

    return "Sync for offline playback";
  }

  function getBundleBadgeLabel(kind: SyncKind, id: string) {
    const bundleKey = getRequestKey(kind, id);
    const visualState = getBundleVisualState(kind, id);
    const progress = syncProgress[bundleKey];

    if (visualState === "syncing") {
      return progress ? `Downloading ${Math.round(progress.fraction * 100)}%` : "Downloading";
    }

    if (visualState === "queued") {
      return "Queued";
    }

    if (visualState === "synced") {
      return "Offline";
    }

    if (visualState === "error") {
      return "Retry sync";
    }

    return null;
  }

  const runSyncRequest = async ({ kind, id }: SyncRequest) => {
    if (!token) {
      return;
    }

    const bundleKey = getRequestKey(kind, id);
    setSyncingKey(bundleKey);
    setSyncProgress((previous) => ({
      ...previous,
      [bundleKey]: {
        completedTracks: 0,
        totalTracks: 0,
        fraction: 0
      }
    }));

    try {
      if (kind === "album") {
        const bundle = await fetchAlbumSyncBundle(apiOptions, id);
        const nextLibrary = await syncAlbumOffline(offlineLibraryRef.current, serverUrl, token, bundle, (progress) => {
          setSyncProgress((previous) => ({
            ...previous,
            [bundleKey]: progress
          }));
        });
        offlineLibraryRef.current = nextLibrary;
        setOfflineLibrary(nextLibrary);
      } else if (kind === "book") {
        const bundle = await fetchBookSyncBundle(apiOptions, id);
        const nextLibrary = await syncBookOffline(offlineLibraryRef.current, serverUrl, token, bundle, (progress) => {
          setSyncProgress((previous) => ({
            ...previous,
            [bundleKey]: progress
          }));
        });
        offlineLibraryRef.current = nextLibrary;
        setOfflineLibrary(nextLibrary);
      } else {
        const bundle = await fetchPlaylistSyncBundle(apiOptions, id);
        const nextLibrary = await syncPlaylistOffline(offlineLibraryRef.current, serverUrl, token, bundle, (progress) => {
          setSyncProgress((previous) => ({
            ...previous,
            [bundleKey]: progress
          }));
        });
        offlineLibraryRef.current = nextLibrary;
        setOfflineLibrary(nextLibrary);
      }
      await logInfo("Offline sync completed", { kind, id });
    } catch (error) {
      setSyncErrors((previous) => ({
        ...previous,
        [bundleKey]: error instanceof Error ? error.message : "Sync failed"
      }));
      await logError("Offline sync failed", error, { kind, id });
    } finally {
      let nextRequest: SyncRequest | null = null;
      setSyncQueue((previous) => {
        if (previous.length === 0) {
          return previous;
        }

        [nextRequest] = previous;
        return previous.slice(1);
      });
      setSyncingKey(null);
      setSyncProgress((previous) => {
        if (!(bundleKey in previous)) {
          return previous;
        }

        const next = { ...previous };
        delete next[bundleKey];
        return next;
      });

      if (nextRequest) {
        void runSyncRequest(nextRequest);
      }
    }
  };

  useEffect(() => {
    if (!token || !serverUrl || playlists.length === 0) {
      return;
    }

    for (const bundle of Object.values(offlineLibrary.bundles)) {
      if (bundle.kind !== "playlist" || refreshedPlaylistSyncsRef.current.has(bundle.id)) {
        continue;
      }

      refreshedPlaylistSyncsRef.current.add(bundle.id);
      syncBundle("playlist", bundle.id);
    }
  }, [offlineLibrary.bundles, playlists, serverUrl, token]);

  const openLibraryAlbums = () => {
    setSearchText("");
    setCurrentItem(null);
    setLibraryMode("albums");
    setView("library");
    setMobileMenuOpen(false);
  };

  const openLibraryBooks = () => {
    setSearchText("");
    setCurrentItem(null);
    setLibraryMode("books");
    setView("library");
    setMobileMenuOpen(false);
  };

  const openLibraryArtists = () => {
    setSearchText("");
    setCurrentItem(null);
    setLibraryMode("artists");
    setView("library");
    setMobileMenuOpen(false);
  };

  const openLibraryPlaylists = () => {
    setSearchText("");
    setCurrentItem(null);
    setLibraryMode("playlists");
    setView("library");
    setMobileMenuOpen(false);
  };

  const openSearchView = () => {
    setSearchText("");
    setView("search");
    setMobileMenuOpen(false);
  };

  const openArtist = (artistName: string) => {
    setCurrentItem({ type: "artist", id: artistName });
    setLibraryMode("artists");
    setView("library");
    setMobileMenuOpen(false);
  };

  const openCurrentCreator = () => {
    if (!currentCreatorName) {
      return;
    }

    openArtist(currentCreatorName);
    setMobilePlayerExpanded(false);
  };

  const openCurrentCollection = async () => {
    if (!currentTrack) {
      return;
    }

    setMobilePlayerExpanded(false);

    if (currentTrack.bookId) {
      await openBook(currentTrack.bookId);
      return;
    }

    if (currentTrack.albumId) {
      await openAlbum(currentTrack.albumId);
      return;
    }

    if (currentQueueEntry?.source === "book" && currentQueueEntry.sourceId) {
      await openBook(currentQueueEntry.sourceId);
      return;
    }

    if (currentQueueEntry?.source === "album" && currentQueueEntry.sourceId) {
      await openAlbum(currentQueueEntry.sourceId);
    }
  };

  const playArtistSelection = async (mode: "play" | "shuffle") => {
    if (!currentItem || currentItem.type !== "artist" || artistTracks.length === 0) {
      return;
    }

    const nextTracks = mode === "shuffle" ? shuffleTracks(artistTracks) : artistTracks;
    await enqueueAndPlay(nextTracks, "search", currentItem.id, 0, undefined, mode !== "shuffle");
  };

  const restoreNavigationSnapshot = async (snapshot: NavigationSnapshot) => {
    restoringNavigationRef.current = true;
    setMobileMenuOpen(false);
    setMobilePlayerExpanded(false);

    if (snapshot.view === "downloads") {
      setCurrentItem(null);
      setView("downloads");
      return;
    }

    if (snapshot.view === "home") {
      setCurrentItem(null);
      setView("home");
      return;
    }

    if (snapshot.view === "search") {
      setCurrentItem(null);
      openSearchView();
      return;
    }

    if (snapshot.view === "liked") {
      setCurrentItem(null);
      openLikedSongs();
      return;
    }

    if (snapshot.view === "library") {
      if (!snapshot.currentItem) {
        setCurrentItem(null);
        setLibraryMode(snapshot.libraryMode);
        setView("library");
        return;
      }

      if (snapshot.currentItem.type === "album") {
        await openAlbum(snapshot.currentItem.id);
        return;
      }

      if (snapshot.currentItem.type === "book") {
        await openBook(snapshot.currentItem.id);
        return;
      }

      if (snapshot.currentItem.type === "playlist") {
        openPlaylist(snapshot.currentItem.id);
        return;
      }

      openArtist(snapshot.currentItem.id);
    }
  };

  useEffect(() => {
    if (!token) {
      return;
    }

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (mobileMenuOpen) {
        setMobileMenuOpen(false);
        return true;
      }

      if (mobilePlayerExpanded) {
        setMobilePlayerExpanded(false);
        return true;
      }

      if (navigationHistoryRef.current.length <= 1) {
        return false;
      }

      const nextHistory = [...navigationHistoryRef.current];
      nextHistory.pop();
      const previous = nextHistory[nextHistory.length - 1];

      if (!previous) {
        return false;
      }

      navigationHistoryRef.current = nextHistory;
      void restoreNavigationSnapshot(previous);
      return true;
    });

    return () => subscription.remove();
  }, [mobileMenuOpen, mobilePlayerExpanded, token]);

  useEffect(() => {
    if (!currentTrack) {
      return;
    }

    void syncLockScreenState(currentTrack, { isPlaying });
  }, [currentTrack, currentTrackLiked, isPlaying]);

  useEffect(() => {
    const handleIncomingUrl = async (url: string | null) => {
      if (!url) {
        return;
      }

      if (url.startsWith("mp3platform://toggle-like")) {
        const activeTrack = queueRef.current[currentIndexRef.current]?.track ?? null;

        if (activeTrack) {
          await toggleTrackLike(activeTrack);
        }
        return;
      }

      if (url.startsWith("mp3platform://previous-track")) {
        const activeTrack = queueRef.current[currentIndexRef.current]?.track ?? null;
        if (activeTrack?.bookId) {
          await seekCurrentTrackBy(-20);
        } else if (currentIndexRef.current > 0) {
          await playQueueAt(currentIndexRef.current - 1);
        }
        return;
      }

      if (url.startsWith("mp3platform://next-track")) {
        const activeTrack = queueRef.current[currentIndexRef.current]?.track ?? null;
        if (activeTrack?.bookId) {
          await seekCurrentTrackBy(20);
        } else if (currentIndexRef.current >= 0 && currentIndexRef.current < queueRef.current.length - 1) {
          await playQueueAt(currentIndexRef.current + 1);
        }
        return;
      }

      if (url.startsWith("mp3platform://browser-toggle-playback")) {
        await togglePlayback();
        return;
      }

      if (url.startsWith("mp3platform://browser-play-current")) {
        if (currentIndexRef.current >= 0) {
          await playQueueAt(currentIndexRef.current, playbackPosition, queueRef.current);
        }
        return;
      }

      if (url.startsWith("mp3platform://browser-play")) {
        try {
          const parsedUrl = new URL(url);
          const source = parsedUrl.searchParams.get("source");
          const sourceId = parsedUrl.searchParams.get("sourceId");
          const trackId = parsedUrl.searchParams.get("trackId");

          if (source && sourceId && trackId) {
            await playTrackFromBrowserSource(source, sourceId, trackId);
          }
        } catch (error) {
          await logError("Browser deep link playback parse failed", error, { url });
        }
        return;
      }
    };

    void Linking.getInitialURL().then((url) => {
      void handleIncomingUrl(url);
    });

    const subscription = Linking.addEventListener("url", ({ url }) => {
      void handleIncomingUrl(url);
    });

    return () => subscription.remove();
  }, [likedTrackIds, token, serverUrl, albums, books, playlists, tracks, summaryText, currentTrack, isPlaying]);

  if (!startupHydrated) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.restoreScreen}>
          <View style={styles.loadingCard}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.restoreText}>Loading your library state...</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <LinearGradient colors={["#171210", "#0b0908"]} style={styles.authBackground}>
          <View style={styles.authCard}>
            <Text style={styles.eyebrow}>Android Player</Text>
            <Text style={styles.authTitle}>Sync books, albums, and playlists for offline listening.</Text>
            <Text style={styles.authSubtitle}>Use the same local MP3 Platform server as the web app so the mobile UI matches your existing library.</Text>
            <TextInput
              placeholder="Server URL"
              placeholderTextColor={theme.muted}
              style={styles.input}
              autoCapitalize="none"
              editable={!busy}
              value={serverUrl}
              onChangeText={setServerUrl}
            />
            {authMode === "register" ? (
              <TextInput
                placeholder="Display name"
                placeholderTextColor={theme.muted}
                style={styles.input}
                editable={!busy}
                value={authName}
                onChangeText={setAuthName}
              />
            ) : null}
            <TextInput
              placeholder="Email"
              placeholderTextColor={theme.muted}
              style={styles.input}
              autoCapitalize="none"
              editable={!busy}
              value={authEmail}
              onChangeText={setAuthEmail}
            />
            <TextInput
              placeholder="Password"
              placeholderTextColor={theme.muted}
              style={styles.input}
              secureTextEntry
              editable={!busy}
              value={authPassword}
              onChangeText={setAuthPassword}
            />
            {authError ? <Text style={styles.errorText}>{authError}</Text> : null}
            <Pressable style={[styles.primaryButton, busy && styles.secondaryButtonDisabled]} disabled={busy} onPress={() => void handleAuthSubmit()}>
              {busy ? <ActivityIndicator color="#04131a" /> : null}
              <Text style={styles.primaryButtonText}>
                {busy
                  ? authMode === "register"
                    ? "Creating account..."
                    : "Signing in..."
                  : authMode === "register"
                    ? "Create Library Owner"
                    : "Connect and Sign In"}
              </Text>
            </Pressable>
            {busy ? <Text style={styles.authSubtitle}>Signing in and restoring your cached library view.</Text> : null}
            {!bootstrapRequiresRegister ? (
              <Pressable style={styles.textButton} disabled={busy} onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}>
                <Text style={styles.textButtonLabel}>
                  {authMode === "login" ? "Need first-user setup?" : "Already have an account?"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </LinearGradient>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.appShell}>
        {isTablet ? (
          <View style={styles.sidebar}>
            <View style={styles.brandRow}>
              <View style={styles.brandIconWrap}>
                <Headphones color={theme.text} size={16} strokeWidth={2.2} />
              </View>
              <Text style={styles.brand}>Groovy</Text>
            </View>
            {safeMap(navigationItems, (item) => (
              <Pressable key={item.id} style={[styles.navButton, view === item.id && styles.navButtonActive]} onPress={() => setView(item.id)}>
                {(() => {
                  const Icon = resolveNavIcon(item.icon);
                  return <Icon color={view === item.id ? "#04131a" : theme.text} size={18} strokeWidth={2.2} />;
                })()}
                <Text style={[styles.navButtonLabel, view === item.id && styles.navButtonLabelActive]}>{item.label}</Text>
              </Pressable>
            ), "sidebar.navigationItems")}
            <View style={styles.sidebarFooter}>
              <Text style={styles.sidebarMeta}>{summaryText}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.mainPane}>
          {showVirtualizedAlbumBrowser ? (
            <FlatList
              data={albumCardItems}
              key={`album-grid-${albumGridColumns}`}
              keyExtractor={(item) => item.key}
              numColumns={albumGridColumns}
              columnWrapperStyle={albumGridColumns > 1 ? styles.albumListRow : undefined}
              contentContainerStyle={[
                styles.scrollContent,
                styles.albumListContent,
                isPhone && { paddingBottom: mobileDockHeight + 18 }
              ]}
              refreshControl={
                token && serverUrl ? (
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => {
                      void handlePullToRefresh();
                    }}
                    tintColor={theme.accent}
                    colors={[theme.accent]}
                    progressBackgroundColor={theme.panel}
                  />
                ) : undefined
              }
              ListHeaderComponent={
                <View style={styles.albumListHeader}>
                  {statusNotice ? (
                    <View style={styles.statusNotice}>
                      <CircleAlert color={theme.accent} size={16} strokeWidth={2.2} />
                      <Text style={styles.statusNoticeText}>{statusNotice}</Text>
                    </View>
                  ) : null}
                  <View style={styles.topbar}>
                    <Text style={styles.pageTitle}>Albums</Text>
                  </View>
                  {heroAlbum ? (
                    <FeaturedEntityHero
                      eyebrow="Featured Album"
                      title={heroAlbum.name}
                      subtitle={`${heroAlbum.artist} · ${heroAlbum.songCount} tracks`}
                      remoteUri={getCoverRemoteUri(heroAlbum.coverArtId)}
                      offlineUri={offlineLibrary.bundles[`album:${heroAlbum.id}`]?.coverUri ?? null}
                      token={token}
                      primaryLabel="Open Album"
                      onPrimaryPress={() => void openAlbum(heroAlbum.id)}
                      syncStatus={getBundleVisualState("album", heroAlbum.id)}
                      onSyncPress={() => void syncBundle("album", heroAlbum.id)}
                    />
                  ) : null}
                </View>
              }
              ListEmptyComponent={<Text style={styles.emptyStateText}>No albums are available yet.</Text>}
              renderItem={({ item }) => (
                <View style={[styles.albumGridCell, albumGridColumns === 3 && styles.albumGridCellTablet]}>
                  <LibraryCard item={item} token={token} />
                </View>
              )}
              removeClippedSubviews
              initialNumToRender={12}
              maxToRenderPerBatch={8}
              windowSize={7}
              updateCellsBatchingPeriod={16}
            />
          ) : showVirtualizedArtistBrowser ? (
            <FlatList
              data={artistCardItems}
              key={`artist-grid-${albumGridColumns}`}
              keyExtractor={(item) => item.key}
              numColumns={albumGridColumns}
              columnWrapperStyle={albumGridColumns > 1 ? styles.albumListRow : undefined}
              contentContainerStyle={[
                styles.scrollContent,
                styles.albumListContent,
                isPhone && { paddingBottom: mobileDockHeight + 18 }
              ]}
              refreshControl={
                token && serverUrl ? (
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => {
                      void handlePullToRefresh();
                    }}
                    tintColor={theme.accent}
                    colors={[theme.accent]}
                    progressBackgroundColor={theme.panel}
                  />
                ) : undefined
              }
              ListHeaderComponent={
                <View style={styles.albumListHeader}>
                  {statusNotice ? (
                    <View style={styles.statusNotice}>
                      <CircleAlert color={theme.accent} size={16} strokeWidth={2.2} />
                      <Text style={styles.statusNoticeText}>{statusNotice}</Text>
                    </View>
                  ) : null}
                  <View style={styles.topbar}>
                    <Text style={styles.pageTitle}>Artists</Text>
                  </View>
                  {featuredArtist ? (
                    <FeaturedEntityHero
                      eyebrow="Featured Artist"
                      title={featuredArtist.name}
                      subtitle={`${featuredArtist.albumCount} albums · ${featuredArtist.totalTracks} tracks`}
                      remoteUri={getCoverRemoteUri(featuredArtist.coverArtId)}
                      offlineUri={featuredArtist.coverUri}
                      token={token}
                      primaryLabel="Open Artist"
                      onPrimaryPress={() => openArtist(featuredArtist.id)}
                    />
                  ) : null}
                </View>
              }
              ListEmptyComponent={<Text style={styles.emptyStateText}>No artists are available yet.</Text>}
              renderItem={({ item }) => (
                <View style={[styles.albumGridCell, albumGridColumns === 3 && styles.albumGridCellTablet]}>
                  <LibraryCard item={item} token={token} />
                </View>
              )}
              removeClippedSubviews
              initialNumToRender={12}
              maxToRenderPerBatch={8}
              windowSize={7}
              updateCellsBatchingPeriod={16}
            />
          ) : (
          <ScrollView
            contentContainerStyle={[
              styles.scrollContent,
              isPhone && { paddingBottom: mobileDockHeight + 18 }
            ]}
            refreshControl={
              token && serverUrl ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    void handlePullToRefresh();
                  }}
                  tintColor={theme.accent}
                  colors={[theme.accent]}
                  progressBackgroundColor={theme.panel}
                />
              ) : undefined
            }
          >
            {statusNotice ? (
              <View style={styles.statusNotice}>
                <CircleAlert color={theme.accent} size={16} strokeWidth={2.2} />
                <Text style={styles.statusNoticeText}>{statusNotice}</Text>
              </View>
            ) : null}

            {busy ? (
              <View style={styles.loadingCard}>
                <ActivityIndicator color={theme.accent} />
              </View>
            ) : null}

            {!busy && view === "home" ? (
              <>
                {homeHero ? (
                  <FeaturedEntityHero
                    eyebrow={homeHero.eyebrow}
                    title={homeHero.title}
                    subtitle={homeHero.subtitle}
                    remoteUri={homeHero.remoteUri}
                    offlineUri={homeHero.offlineUri}
                    token={token}
                    primaryLabel={homeHero.primaryLabel}
                    onPrimaryPress={homeHero.onPrimaryPress}
                    syncStatus={homeHero.syncStatus}
                    onSyncPress={homeHero.onSyncPress}
                  />
                ) : (
                  <LinearGradient colors={["rgba(8,210,255,0.08)", "rgba(214,150,87,0.08)", "rgba(16,12,10,0.96)"]} style={styles.heroCard}>
                  {heroAlbum ? (
                    <View style={styles.heroArt}>
                      <AlbumArt
                        remoteUri={getCoverRemoteUri(heroAlbum.coverArtId)}
                        offlineUri={offlineLibrary.bundles[`album:${heroAlbum.id}`]?.coverUri ?? null}
                        token={token}
                      />
                      <LinearGradient
                        colors={["rgba(9,7,6,0.16)", "rgba(9,7,6,0.72)", "rgba(9,7,6,0.96)"]}
                        start={{ x: 0.5, y: 0 }}
                        end={{ x: 0.5, y: 1 }}
                        style={styles.heroShade}
                      />
                      <LinearGradient
                        colors={["rgba(9,7,6,0.92)", "rgba(9,7,6,0.56)", "rgba(9,7,6,0.12)"]}
                        start={{ x: 0, y: 0.5 }}
                        end={{ x: 1, y: 0.5 }}
                        style={styles.heroShade}
                      />
                    </View>
                  ) : null}
                  <View style={styles.heroCopy}>
                    <Text style={styles.eyebrow}>Featured Album</Text>
                    <Text style={styles.heroTitle}>{heroAlbum ? heroAlbum.name : "Browse your library"}</Text>
                    <Text style={styles.heroSubtitle}>
                      {heroAlbum ? `${heroAlbum.artist} · ${heroAlbum.songCount} tracks` : "Albums, books, playlists, and playback stay visually consistent with the web app."}
                    </Text>
                    {heroAlbum ? (
                      <View style={styles.heroActions}>
                        <Pressable style={styles.primaryButton} onPress={() => void openAlbum(heroAlbum.id)}>
                          <Text style={styles.primaryButtonText}>Open Album</Text>
                        </Pressable>
                        <SyncActionButton
                          status={getBundleVisualState("album", heroAlbum.id)}
                          onPress={() => syncBundle("album", heroAlbum.id)}
                          accessibilityLabel={
                            getBundleVisualState("album", heroAlbum.id) === "synced" ? "Album synced offline" : "Sync album offline"
                          }
                        />
                      </View>
                    ) : null}
                  </View>
                </LinearGradient>
                )}

                <SectionHeader title="Albums" subtitle="Tap into your indexed releases" onPress={openLibraryAlbums} />
                <CardGrid
                  items={visibleAlbums.slice(0, isTablet ? 6 : 4).map((album) => ({
                    key: album.id,
                    title: album.name,
                    subtitle: album.artist,
                    accent: null,
                    artCornerIcon: getBundleVisualState("album", album.id) === "synced"
                      ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
                      : undefined,
                    artCornerIconAlign: "right",
                    remoteUri: getCoverRemoteUri(album.coverArtId),
                    offlineUri: offlineLibrary.bundles[`album:${album.id}`]?.coverUri ?? null,
                    onPress: () => void openAlbum(album.id)
                  }))}
                  token={token}
                />

                <SectionHeader title="Artists" subtitle="Jump back into recent artist pages" onPress={openLibraryArtists} />
                <CardGrid
                  items={recentArtists.map((artist) => ({
                    key: artist.id,
                    title: artist.name,
                    subtitle: `${artist.albumCount} albums · ${artist.totalTracks} tracks`,
                    accent: null,
                    remoteUri: getCoverRemoteUri(artist.coverArtId),
                    offlineUri: artist.coverUri,
                    onPress: () => openArtist(artist.id)
                  }))}
                  token={token}
                />

                <SectionHeader title="Books" subtitle="Resume-friendly shelves for audiobooks" onPress={openLibraryBooks} />
                <CardGrid
                  items={recentBooks.map((book) => ({
                    key: book.id,
                    title: book.title,
                    subtitle: `${book.author} · ${formatDuration(book.durationSeconds)}`,
                    accent: null,
                    artBadgeAlign: "right",
                    artCornerIcon: getBundleVisualState("book", book.id) === "synced"
                      ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
                      : undefined,
                    artCornerIconAlign: "right",
                    artBadge: (() => {
                      const progress = book.lastTrackId
                        ? {
                            trackId: book.lastTrackId,
                            positionSeconds: book.lastPositionSeconds ?? 0
                          }
                        : null;
                      const bookTracks = tracks.filter((track) => track.bookId === book.id);

                      if (isBookCompleted(progress, bookTracks)) {
                        return (
                          <View style={[styles.cardArtBadge, styles.cardArtBadgeComplete]}>
                            <Text style={[styles.cardArtBadgeText, styles.cardArtBadgeTextComplete]}>Complete</Text>
                          </View>
                        );
                      }

                      if (isBookInProgress(progress, bookTracks)) {
                        return (
                          <View style={[styles.cardArtBadge, styles.cardArtBadgeProgress]}>
                            <Text style={styles.cardArtBadgeText}>In Progress</Text>
                          </View>
                        );
                      }

                      return undefined;
                    })(),
                    remoteUri: getCoverRemoteUri(book.coverArtId),
                    offlineUri: offlineLibrary.bundles[`book:${book.id}`]?.coverUri ?? null,
                    onPress: () => void openBook(book.id)
                  }))}
                  token={token}
                />

                <SectionHeader title="Playlists" subtitle="Queue up saved mixes for online or offline listening" onPress={openLibraryPlaylists} />
                <CardGrid
                  items={recentPlaylists.map((playlist) => ({
                    key: playlist.id,
                    title: playlist.name,
                    subtitle: getPlaylistDisplaySubtitle(playlist),
                    accent: null,
                    artCornerIcon: !isSmartPlaylistRecord(playlist) && getBundleVisualState("playlist", playlist.id) === "synced"
                      ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
                      : undefined,
                    artCornerIconAlign: "left",
                    remoteUri: getCoverRemoteUri(playlist.coverArtId),
                    offlineUri: offlineLibrary.bundles[`playlist:${playlist.id}`]?.coverUri ?? null,
                    onPress: () => openPlaylist(playlist.id)
                  }))}
                  token={token}
                />
              </>
            ) : null}

            {!busy && view === "library" ? (
              <>
                {!currentItem ? (
                  <View style={styles.topbar}>
                    <Text style={styles.pageTitle}>
                      {libraryMode === "albums"
                        ? "Albums"
                        : libraryMode === "artists"
                          ? "Artists"
                          : libraryMode === "books"
                            ? "Books"
                            : "Playlists"}
                    </Text>
                  </View>
                ) : null}
                {libraryMode === "albums" && currentItem?.type === "album" && albumDetail ? (
                  <DetailCard
                    entityLabel="Album"
                    title={albumDetail.album.name}
                    subtitle={`${albumDetail.album.artist} · ${albumDetail.album.songCount} tracks`}
                    body={albumDetail.review ?? albumDetail.outline ?? "Play the album in order or sync it to your device for offline listening."}
                    syncStatus={getBundleVisualState("album", albumDetail.album.id)}
                    heroRemoteUri={getCoverRemoteUri(albumDetail.album.coverArtId)}
                    heroOfflineUri={offlineLibrary.bundles[`album:${albumDetail.album.id}`]?.coverUri ?? null}
                    token={token}
                    onPlay={() => void enqueueAndPlay(albumDetail.tracks, "album", albumDetail.album.id)}
                    onShuffle={() => void enqueueAndPlay(shuffleTracks(albumDetail.tracks), "album", albumDetail.album.id, 0, undefined, true)}
                    onPlayNext={() => void appendSelectionToQueue(albumDetail.tracks, "album", albumDetail.album.id)}
                    onSync={() => void syncBundle("album", albumDetail.album.id)}
                    onRemove={() => promptRemoveBundle("album", albumDetail.album.id)}
                  >
                    {sortTracksByOrder(albumDetail.tracks).map((track, index) => (
                      <TrackRow
                        key={track.id}
                        leadingLabel={`${track.trackNumber ?? index + 1}.`}
                        title={track.title ?? "Untitled track"}
                        subtitle=""
                        trailing={null}
                        isActive={currentTrack?.id === track.id}
                        isPlaying={isPlaying}
                        onPress={() => void onSelectTrack(track, "album", albumDetail.album.id, albumDetail.tracks)}
                        onAddToPlaylist={() => openPlaylistPicker(track)}
                        onAddNextToQueue={() => void insertTrackNextInQueue(track, "album", albumDetail.album.id)}
                        onAddLastToQueue={() => void appendTrackToQueue(track, "album", albumDetail.album.id)}
                      />
                    ))}
                  </DetailCard>
                ) : null}

                {libraryMode === "books" && currentItem?.type === "book" && bookDetail ? (
                  <DetailCard
                    entityLabel="Book"
                    title={bookDetail.book.title}
                    subtitle={`${bookDetail.book.author} · ${bookDetail.book.trackCount} chapters · ${formatHourMinuteDuration(bookDetail.book.durationSeconds)}`}
                    body={
                      hasMeaningfulBookProgress(bookDetail.progress, bookDetail.tracks) && bookDetail.progress
                        ? `Resume from ${formatTrackTime(bookDetail.progress.positionSeconds)} in your last chapter, or keep the full book stored offline.`
                        : "Start from the beginning, jump chapters, or sync the whole book for travel."
                    }
                    syncStatus={getBundleVisualState("book", bookDetail.book.id)}
                    heroRemoteUri={getCoverRemoteUri(bookDetail.book.coverArtId)}
                    heroOfflineUri={offlineLibrary.bundles[`book:${bookDetail.book.id}`]?.coverUri ?? null}
                    token={token}
                    primaryLabel={hasMeaningfulBookProgress(bookDetail.progress, bookDetail.tracks) ? "Continue" : "Play"}
                    onPlay={() => {
                      const orderedTracks = sortTracksByOrder(bookDetail.tracks);
                      const canResume = hasMeaningfulBookProgress(bookDetail.progress, orderedTracks);
                      const progressTrackIndex = bookDetail.progress?.trackId
                        ? orderedTracks.findIndex((track) => track.id === bookDetail.progress?.trackId)
                        : -1;

                      return void enqueueAndPlay(
                        orderedTracks,
                        "book",
                        bookDetail.book.id,
                        canResume && progressTrackIndex >= 0 ? progressTrackIndex : 0,
                        canResume ? bookDetail.progress?.positionSeconds : 0
                      );
                    }}
                    onPlayNext={() => void appendSelectionToQueue(bookDetail.tracks, "book", bookDetail.book.id)}
                    onSync={() => void syncBundle("book", bookDetail.book.id)}
                    onRemove={() => promptRemoveBundle("book", bookDetail.book.id)}
                    onRestart={
                      hasMeaningfulBookProgress(bookDetail.progress, bookDetail.tracks)
                        ? () => restartBookFromBeginning(bookDetail)
                        : null
                    }
                    onMarkAsRead={
                      isBookCompleted(bookDetail.progress, bookDetail.tracks)
                        ? null
                        : () => markBookAsRead(bookDetail)
                    }
                    restartAccessibilityLabel="Restart book from the beginning"
                    extraActionIcon={
                      hasMeaningfulBookProgress(bookServerProgress, bookDetail.tracks)
                        ? <BookmarkCheck color="#65d46e" size={16} strokeWidth={2.2} />
                        : null
                    }
                    onExtraAction={
                      hasMeaningfulBookProgress(bookServerProgress, bookDetail.tracks)
                        ? () => showStatusNotice(buildBookProgressStatusLabel(bookServerProgress, bookDetail.tracks) ?? "Bookmark synced.")
                        : null
                    }
                    extraActionLabel="Show synced bookmark position"
                    heroBadgeLabel={
                      isBookCompleted(bookDetail.progress, bookDetail.tracks)
                        ? "Completed"
                        : isBookInProgress(bookDetail.progress, bookDetail.tracks)
                          ? "In progress"
                          : null
                    }
                    trailingStatusIcons={
                      isBookCompleted(bookDetail.progress, bookDetail.tracks)
                        ? [<CircleCheck key="book-complete" color="#65d46e" size={16} strokeWidth={2.2} />]
                        : undefined
                    }
                  >
                    {sortTracksByOrder(bookDetail.tracks).map((track, index) => (
                      <TrackRow
                        key={track.id}
                        leadingLabel={`${track.trackNumber ?? index + 1}.`}
                        title={track.title ?? "Untitled chapter"}
                        subtitle=""
                        trailing={null}
                        isActive={currentTrack?.id === track.id}
                        isPlaying={isPlaying}
                        onPress={() =>
                          void onSelectTrack(track, "book", bookDetail.book.id, bookDetail.tracks)
                        }
                        onAddToPlaylist={() => openPlaylistPicker(track)}
                      />
                    ))}
                  </DetailCard>
                ) : null}

                {libraryMode === "playlists" && currentItem?.type === "playlist" && playlistDetail ? (
                  <DetailCard
                    entityLabel="Playlist"
                    title={playlistDetail.name}
                    subtitle={getPlaylistDisplaySubtitle(playlistDetail)}
                    body={
                      playlistDetail.description ??
                      "Play the full playlist now or keep it synced offline. Newly added tracks will be picked up automatically the next time the app loads."
                    }
                    syncStatus={isSmartPlaylistRecord(playlistDetail) ? undefined : getBundleVisualState("playlist", playlistDetail.id)}
                    heroRemoteUri={getCoverRemoteUri(playlistDetail.coverArtId)}
                    heroOfflineUri={offlineLibrary.bundles[`playlist:${playlistDetail.id}`]?.coverUri ?? null}
                    token={token}
                    onPlay={() => void enqueueAndPlay(playlistDetail.tracks, "playlist", playlistDetail.id, 0, undefined, true)}
                    onShuffle={() => void enqueueAndPlay(shuffleTracks(playlistDetail.tracks), "playlist", playlistDetail.id, 0, undefined, true)}
                    onPlayNext={() => void appendSelectionToQueue(playlistDetail.tracks, "playlist", playlistDetail.id, true)}
                    onSync={isSmartPlaylistRecord(playlistDetail) ? undefined : () => void syncBundle("playlist", playlistDetail.id)}
                    onRemove={isSmartPlaylistRecord(playlistDetail) ? undefined : () => promptRemoveBundle("playlist", playlistDetail.id)}
                  >
                    {playlistDetail.tracks.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        leadingLabel={`${track.trackNumber ?? index + 1}.`}
                        title={track.title ?? "Untitled track"}
                        subtitle=""
                        trailing={formatTrackTime(track.durationSeconds)}
                        isActive={currentTrack?.id === track.id}
                        isPlaying={isPlaying}
                        onPress={() => void onSelectTrack(track, "playlist", playlistDetail.id, playlistDetail.tracks)}
                        onAddToPlaylist={() => openPlaylistPicker(track)}
                        onAddNextToQueue={() => void insertTrackNextInQueue(track, "playlist", playlistDetail.id)}
                        onAddLastToQueue={() => void appendTrackToQueue(track, "playlist", playlistDetail.id)}
                      />
                    ))}
                  </DetailCard>
                ) : null}

                {libraryMode === "artists" && currentItem?.type === "artist" ? (
                  <View style={styles.panel}>
                    <View style={[styles.detailHeader, (artistHeaderRemoteUri || artistHeaderOfflineUri) && styles.detailHeaderWithArt]}>
                      {artistHeaderRemoteUri || artistHeaderOfflineUri ? (
                        <View style={styles.detailHeaderArt}>
                          <AlbumArt remoteUri={artistHeaderRemoteUri ?? null} offlineUri={artistHeaderOfflineUri ?? null} token={token ?? null} />
                          <LinearGradient
                            colors={["rgba(9,7,6,0.18)", "rgba(9,7,6,0.78)", "rgba(9,7,6,0.97)"]}
                            start={{ x: 0.5, y: 0 }}
                            end={{ x: 0.5, y: 1 }}
                            style={styles.detailHeaderShade}
                          />
                          <LinearGradient
                            colors={["rgba(9,7,6,0.96)", "rgba(9,7,6,0.58)", "rgba(9,7,6,0.14)"]}
                            start={{ x: 0, y: 0.5 }}
                            end={{ x: 1, y: 0.5 }}
                            style={styles.detailHeaderShade}
                          />
                        </View>
                      ) : null}
                      <View style={styles.detailHeaderCopy}>
                        <Text style={styles.eyebrow}>Artist</Text>
                        <Text style={styles.detailTitle}>{currentItem.id}</Text>
                        <Text style={styles.detailSubtitle}>{`${artistAlbums.length} albums / ${artistBooks.length} books`}</Text>
                        <Text style={styles.detailBody}>Play this artist in sequence, shuffle everything, or dive into albums and books below.</Text>
                      </View>
                    </View>
                    <View style={styles.detailActions}>
                      <Pressable style={[styles.primaryButton, styles.detailPrimaryActionButton]} onPress={() => void playArtistSelection("play")}>
                        <Play color="#04131a" size={16} strokeWidth={2.4} />
                        <Text style={styles.primaryButtonText}>Play</Text>
                      </Pressable>
                      <Pressable style={styles.iconActionButton} onPress={() => void playArtistSelection("shuffle")} accessibilityLabel="Shuffle artist">
                        <Shuffle color={theme.text} size={16} strokeWidth={2.2} />
                      </Pressable>
                      <Pressable
                        style={styles.iconActionButton}
                        onPress={() => void appendSelectionToQueue(artistTracks, "search", currentItem.id, true)}
                        accessibilityLabel="Add artist to end of queue"
                      >
                        <ListEnd color={theme.text} size={16} strokeWidth={2.2} />
                      </Pressable>
                    </View>
                    <SectionHeader
                      title={currentItem.id}
                      subtitle={`${artistAlbums.length} albums · ${artistBooks.length} books`}
                    />
                    {artistAlbums.length > 0 ? (
                      <>
                        <SectionHeader title="Albums" subtitle={`${artistAlbums.reduce((count, album) => count + album.songCount, 0)} tracks`} />
                        <CardGrid
                          columns={1}
                          items={artistAlbums.map((album) => ({
                            key: album.id,
                            title: album.name,
                            subtitle: `${formatDuration(album.durationSeconds)} · ${album.songCount} tracks`,
                            accent: null,
                            artCornerIcon: getBundleVisualState("album", album.id) === "synced"
                              ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
                              : undefined,
                            artCornerIconAlign: "right",
                            remoteUri: getCoverRemoteUri(album.coverArtId),
                            offlineUri: offlineLibrary.bundles[`album:${album.id}`]?.coverUri ?? null,
                            onPress: () => void openAlbum(album.id)
                          }))}
                          token={token}
                        />
                      </>
                    ) : null}
                    {artistBooks.length > 0 ? (
                      <>
                        <SectionHeader title="Books" subtitle={`${artistBooks.reduce((count, book) => count + book.trackCount, 0)} chapters`} />
                        <CardGrid
                          items={artistBooks.map((book) => ({
                            key: book.id,
                            title: book.title,
                            subtitle: `${book.trackCount} chapters · ${formatDuration(book.durationSeconds)}`,
                            accent: getBundleBadgeLabel("book", book.id),
                            icon: isBookCompleted(
                              book.lastTrackId
                                ? {
                                    trackId: book.lastTrackId,
                                    positionSeconds: book.lastPositionSeconds ?? 0
                                  }
                                : null,
                              tracks.filter((track) => track.bookId === book.id)
                            ) ? (
                              <CircleCheck color="#65d46e" size={16} strokeWidth={2.2} />
                            ) : undefined,
                            remoteUri: getCoverRemoteUri(book.coverArtId),
                            offlineUri: offlineLibrary.bundles[`book:${book.id}`]?.coverUri ?? null,
                            onPress: () => void openBook(book.id)
                          }))}
                          token={token}
                        />
                      </>
                    ) : null}
                  </View>
                ) : null}

                {libraryMode === "albums" && (!currentItem || currentItem.type !== "album") ? (
                  <>
                    {heroAlbum ? (
                      <FeaturedEntityHero
                        eyebrow="Featured Album"
                        title={heroAlbum.name}
                        subtitle={`${heroAlbum.artist} · ${heroAlbum.songCount} tracks`}
                        remoteUri={getCoverRemoteUri(heroAlbum.coverArtId)}
                        offlineUri={offlineLibrary.bundles[`album:${heroAlbum.id}`]?.coverUri ?? null}
                        token={token}
                        primaryLabel="Open Album"
                        onPrimaryPress={() => void openAlbum(heroAlbum.id)}
                        syncStatus={getBundleVisualState("album", heroAlbum.id)}
                        onSyncPress={() => void syncBundle("album", heroAlbum.id)}
                      />
                    ) : null}
                  </>
                ) : null}

                {libraryMode === "artists" && (!currentItem || currentItem.type !== "artist") ? (
                  <>
                    {featuredArtist ? (
                      <FeaturedEntityHero
                        eyebrow="Featured Artist"
                        title={featuredArtist.name}
                        subtitle={`${featuredArtist.albumCount} albums · ${featuredArtist.totalTracks} tracks`}
                        remoteUri={getCoverRemoteUri(featuredArtist.coverArtId)}
                        offlineUri={featuredArtist.coverUri}
                        token={token}
                        primaryLabel="Open Artist"
                        onPrimaryPress={() => openArtist(featuredArtist.id)}
                      />
                    ) : null}
                  <CardGrid
                    items={filteredArtists.map((artist) => ({
                      key: artist.id,
                      title: artist.name,
                      subtitle: `${artist.albumCount} albums · ${artist.totalTracks} tracks`,
                      accent: "Artist",
                      remoteUri: getCoverRemoteUri(artist.coverArtId),
                      offlineUri: artist.coverUri,
                      onPress: () => openArtist(artist.id)
                    }))}
                    token={token}
                  />
                  </>
                ) : null}

                {libraryMode === "books" && (!currentItem || currentItem.type !== "book") ? (
                  <>
                    {featuredBook ? (
                      <FeaturedEntityHero
                        eyebrow="Featured Book"
                        title={featuredBook.title}
                        subtitle={`${featuredBook.author} · ${featuredBook.trackCount} chapters`}
                        remoteUri={getCoverRemoteUri(featuredBook.coverArtId)}
                        offlineUri={offlineLibrary.bundles[`book:${featuredBook.id}`]?.coverUri ?? null}
                        token={token}
                        primaryLabel="Open Book"
                        onPrimaryPress={() => void openBook(featuredBook.id)}
                        syncStatus={getBundleVisualState("book", featuredBook.id)}
                        onSyncPress={() => void syncBundle("book", featuredBook.id)}
                      />
                    ) : null}
                  <CardGrid
                    items={filteredBooks.map((book) => ({
                      key: book.id,
                      title: book.title,
                      subtitle: book.author,
                      accent: null,
                      artBadgeAlign: "right",
                      artCornerIcon: getBundleVisualState("book", book.id) === "synced"
                        ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
                        : undefined,
                      artCornerIconAlign: "right",
                      artBadge: (() => {
                        const progress = book.lastTrackId
                          ? {
                              trackId: book.lastTrackId,
                              positionSeconds: book.lastPositionSeconds ?? 0
                            }
                          : null;
                        const bookTracks = tracks.filter((track) => track.bookId === book.id);

                        if (isBookCompleted(progress, bookTracks)) {
                          return (
                            <View style={[styles.cardArtBadge, styles.cardArtBadgeComplete]}>
                              <Text style={[styles.cardArtBadgeText, styles.cardArtBadgeTextComplete]}>Complete</Text>
                            </View>
                          );
                        }

                        if (isBookInProgress(progress, bookTracks)) {
                          return (
                            <View style={[styles.cardArtBadge, styles.cardArtBadgeProgress]}>
                              <Text style={styles.cardArtBadgeText}>In Progress</Text>
                            </View>
                          );
                        }

                        return undefined;
                      })(),
                      remoteUri: getCoverRemoteUri(book.coverArtId),
                      offlineUri: offlineLibrary.bundles[`book:${book.id}`]?.coverUri ?? null,
                      onPress: () => void openBook(book.id)
                    }))}
                    token={token}
                  />
                  </>
                ) : null}

                {libraryMode === "playlists" && (!currentItem || currentItem.type !== "playlist") ? (
                  <>
                    {featuredPlaylist ? (
                      <FeaturedEntityHero
                        eyebrow="Featured Playlist"
                        title={featuredPlaylist.name}
                        subtitle={getPlaylistDisplaySubtitle(featuredPlaylist)}
                        remoteUri={getCoverRemoteUri(featuredPlaylist.coverArtId)}
                        offlineUri={offlineLibrary.bundles[`playlist:${featuredPlaylist.id}`]?.coverUri ?? null}
                        token={token}
                        primaryLabel="Open Playlist"
                        onPrimaryPress={() => openPlaylist(featuredPlaylist.id)}
                        syncStatus={isSmartPlaylistRecord(featuredPlaylist) ? undefined : getBundleVisualState("playlist", featuredPlaylist.id)}
                        onSyncPress={isSmartPlaylistRecord(featuredPlaylist) ? undefined : () => void syncBundle("playlist", featuredPlaylist.id)}
                      />
                    ) : null}
                    {filteredPersonalPlaylists.length > 0 ? (
                      <>
                        <SectionHeader title="Your Playlist Shelf" subtitle="Created from track actions" />
                        <CardGrid
                          items={filteredPersonalPlaylists.map((playlist) => ({
                            key: playlist.id,
                            title: playlist.name,
                            subtitle: getPlaylistDisplaySubtitle(playlist),
                            accent: null,
                            artCornerIcon: getBundleVisualState("playlist", playlist.id) === "synced"
                              ? <CloudCheck color={theme.accent} size={18} strokeWidth={2.2} />
                              : undefined,
                            artCornerIconAlign: "right",
                            remoteUri: getCoverRemoteUri(playlist.coverArtId),
                            offlineUri: offlineLibrary.bundles[`playlist:${playlist.id}`]?.coverUri ?? null,
                            onPress: () => openPlaylist(playlist.id)
                          }))}
                          token={token}
                        />
                      </>
                    ) : null}
                    {filteredSmartPlaylists.length > 0 ? (
                      <>
                        <SectionHeader title="Playlist Deck" subtitle="One-click full playback" />
                        <CardGrid
                          items={filteredSmartPlaylists.map((playlist) => ({
                            key: playlist.id,
                            title: playlist.name,
                            subtitle: getPlaylistDisplaySubtitle(playlist),
                            accent: null,
                            remoteUri: getCoverRemoteUri(playlist.coverArtId),
                            offlineUri: offlineLibrary.bundles[`playlist:${playlist.id}`]?.coverUri ?? null,
                            onPress: () => openPlaylist(playlist.id)
                          }))}
                          token={token}
                        />
                      </>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}

            {!busy && view === "search" ? (
              <View style={styles.panel}>
                <View style={[styles.topbar, styles.searchTopbar]}>
                  <Text style={styles.pageTitle}>Search</Text>
                  <Text style={styles.pageSubtitle}>Previous search terms and matching library content</Text>
                </View>
                <TextInput
                  placeholder="Search albums, books, or playlists"
                  placeholderTextColor={theme.muted}
                  style={styles.searchInput}
                  value={searchText}
                  onChangeText={setSearchText}
                />
                {trimmedSearchText.length === 0 ? (
                  <View style={styles.searchHistoryList}>
                    {searchHistory.length === 0 ? (
                      <Text style={styles.emptyStateText}>No previous searches yet.</Text>
                    ) : (
                      searchHistory.map((term) => (
                        <Pressable key={term} style={styles.searchTermRow} onPress={() => setSearchText(term)}>
                          <Text style={styles.trackTitle}>{term}</Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                ) : (
                  <View style={styles.searchResultsList}>
                    {searchResults.length === 0 ? (
                      <Text style={styles.emptyStateText}>No matching albums, books, or playlists were found.</Text>
                    ) : (
                      searchResults.map((item) => (
                        <Pressable
                          key={item.key}
                          style={styles.searchRow}
                          onPress={() => {
                            if (item.kind === "album") {
                              void openAlbum(item.id);
                              return;
                            }

                            if (item.kind === "book") {
                              void openBook(item.id);
                              return;
                            }

                            openPlaylist(item.id);
                          }}
                        >
                          <View style={styles.searchArt}>
                            <AlbumArt remoteUri={item.remoteUri} offlineUri={item.offlineUri} token={token} />
                          </View>
                          <View style={styles.searchCopy}>
                            <Text style={styles.trackTitle}>{item.label}</Text>
                            <View style={styles.searchMetaRow}>
                              {getBundleVisualState(item.kind, item.id) === "synced" ? (
                                <CloudCheck color={theme.accent} size={14} strokeWidth={2.1} />
                              ) : null}
                              <Text style={styles.trackSubtitle}>
                                {item.kind === "album" ? "Album" : item.kind === "book" ? "Book" : "Playlist"}
                              </Text>
                              <Text style={styles.searchMetaDot}>·</Text>
                              <Text style={styles.trackSubtitle}>{item.meta}</Text>
                            </View>
                          </View>
                        </Pressable>
                      ))
                    )}
                  </View>
                )}
              </View>
            ) : null}

            {!busy && view === "liked" ? (
              <DetailCard
                entityLabel="Liked Songs"
                title="Liked Songs"
                subtitle={`${likedTracks.length} tracks`}
                body="Every liked song syncs with the web app. Play the full list in order, shuffle it, or remove tracks with the heart button."
                heroRemoteUri={getCoverRemoteUri(likedTracks[0]?.coverArtId ?? null)}
                heroOfflineUri={likedTracks[0] ? getOfflineCoverUri(offlineLibrary, likedTracks[0].id, likedTracks[0].coverArtId) : null}
                token={token}
                onPlay={() => void enqueueAndPlay(likedTracks, "search", "liked", 0, undefined, true)}
                onShuffle={() => void enqueueAndPlay(shuffleTracks(likedTracks), "search", "liked", 0, undefined, true)}
                onPlayNext={() => void appendSelectionToQueue(likedTracks, "search", "liked", true)}
              >
                {likedTracks.length === 0 ? (
                  <Text style={styles.emptyStateText}>No liked songs yet.</Text>
                ) : (
                  likedTracks.map((track, index) => (
                    <TrackRow
                      key={track.id}
                      leadingLabel={`${track.trackNumber ?? index + 1}.`}
                      title={track.title ?? "Untitled track"}
                      subtitle={getBookTrackAuthor(track) ?? ""}
                      trailing={track.bookId ? null : formatTrackTime(track.durationSeconds)}
                      isActive={currentTrack?.id === track.id}
                      isPlaying={isPlaying}
                      isLiked={likedTrackIds.has(track.id)}
                      onToggleLike={() => void toggleTrackLike(track)}
                      onAddToPlaylist={() => openPlaylistPicker(track)}
                      onPress={() => void onSelectTrack(track, "search", "liked", likedTracks)}
                      onAddNextToQueue={() => void insertTrackNextInQueue(track, "search", "liked")}
                      onAddLastToQueue={() => void appendTrackToQueue(track, "search", "liked")}
                    />
                  ))
                )}
              </DetailCard>
            ) : null}

            {!busy && view === "downloads" ? (
              <View style={styles.panel}>
                <View style={styles.topbar}>
                  <Text style={styles.pageTitle}>Downloads</Text>
                  <Text style={styles.pageSubtitle}>Manage offline content and the active sync queue</Text>
                </View>

                <View style={styles.downloadSection}>
                  {downloadEntries.length > 0 ? (
                    downloadEntries.map((entry) => (
                      <View key={entry.key} style={styles.downloadRow}>
                        <View style={styles.downloadStatusIcon}>
                          {entry.status === "syncing" ? (
                            <ActivityIndicator color={theme.accent} />
                          ) : entry.status === "queued" ? (
                            <Hourglass color={theme.muted} size={18} strokeWidth={2} />
                          ) : (
                            <CloudCheck color={theme.accent} size={18} strokeWidth={2.1} />
                          )}
                        </View>
                        <View style={styles.downloadCopy}>
                          <Text style={styles.trackTitle}>{entry.title}</Text>
                          <Text style={styles.trackSubtitle}>{entry.subtitle}</Text>
                        </View>
                        {entry.status === "synced" ? (
                          <Pressable
                            style={styles.iconActionButton}
                            onPress={() => {
                              const request = parseBundleKey(entry.key);
                              promptRemoveBundle(request.kind, request.id);
                            }}
                            accessibilityLabel={`Remove offline copy of ${entry.title}`}
                          >
                            <Trash2 color={theme.text} size={18} strokeWidth={2} />
                          </Pressable>
                        ) : null}
                      </View>
                    ))
                  ) : (
                    <Text style={styles.emptyStateText}>No downloaded or queued content yet.</Text>
                  )}
                </View>

                {false ? (
                  <>
                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Currently Downloading</Text>
                  {syncingKey !== null ? (
                    (() => {
                      const activeKey = syncingKey!;
                      const request = parseBundleKey(activeKey);
                      const summary = getBundleSummary(request.kind, request.id);
                      const progress = syncProgress[activeKey];
                      return (
                        <View style={styles.downloadRow}>
                          <ActivityIndicator color={theme.accent} />
                          <View style={styles.downloadCopy}>
                            <Text style={styles.trackTitle}>{summary.title}</Text>
                            <Text style={styles.trackSubtitle}>
                              {progress
                                ? `${summary.subtitle} · ${progress.completedTracks}/${progress.totalTracks} tracks · ${Math.round(progress.fraction * 100)}%`
                                : summary.subtitle}
                            </Text>
                          </View>
                        </View>
                      );
                    })()
                  ) : (
                    <Text style={styles.emptyStateText}>Nothing is downloading right now.</Text>
                  )}
                </View>

                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Queue</Text>
                  {syncQueue.length > 0 ? (
                    syncQueue.map((request) => {
                      const summary = getBundleSummary(request.kind, request.id);
                      return (
                        <View key={`${request.kind}:${request.id}`} style={styles.downloadRow}>
                          <CloudDownload color={theme.muted} size={18} strokeWidth={1.9} />
                          <View style={styles.downloadCopy}>
                            <Text style={styles.trackTitle}>{summary.title}</Text>
                            <Text style={styles.trackSubtitle}>{summary.subtitle} · Queued</Text>
                          </View>
                        </View>
                      );
                    })
                  ) : (
                    <Text style={styles.emptyStateText}>No pending downloads in the queue.</Text>
                  )}
                </View>

                {Object.keys(syncErrors).length > 0 ? (
                  <View style={styles.downloadSection}>
                    <Text style={styles.downloadSectionTitle}>Sync Issues</Text>
                    {Object.entries(syncErrors).map(([bundleKey, message]) => {
                      const request = parseBundleKey(bundleKey);
                      const summary = getBundleSummary(request.kind, request.id);
                      return (
                        <View key={bundleKey} style={styles.downloadRow}>
                          <CircleAlert color={theme.danger} size={18} strokeWidth={2} />
                          <View style={styles.downloadCopy}>
                            <Text style={styles.trackTitle}>{summary.title}</Text>
                            <Text style={[styles.trackSubtitle, styles.syncErrorText]}>{message}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Synced Content</Text>
                  {syncedBundles.length > 0 ? (
                    syncedBundles.map(({ key, bundle }) => (
                      <View key={key} style={styles.downloadRow}>
                        <View style={styles.downloadArt}>
                          <AlbumArt remoteUri={null} offlineUri={bundle.coverUri} token={token} />
                        </View>
                        <View style={styles.downloadCopy}>
                          <Text style={styles.trackTitle}>{bundle.title}</Text>
                          <Text style={styles.trackSubtitle}>
                            {bundle.subtitle} · {bundle.trackIds.length} items
                          </Text>
                        </View>
                        <Pressable
                          style={styles.iconActionButton}
                          onPress={() => void removeBundle(bundle.kind, bundle.id)}
                          accessibilityLabel={`Remove offline copy of ${bundle.title}`}
                        >
                          <Trash2 color={theme.text} size={18} strokeWidth={2} />
                        </Pressable>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.emptyStateText}>No synced albums or books yet.</Text>
                  )}
                </View>
                  </>
                ) : null}

                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Diagnostics</Text>
                  <Text style={styles.emptyStateText}>
                    Local app logs are stored on the device so we can inspect startup and runtime failures without USB debugging.
                  </Text>
                  <Text style={styles.downloadSectionTitle}>Lock Screen Snapshot</Text>
                  <Text style={styles.emptyStateText}>
                    This snapshot shows the native player session state we expect Android to use for the lock screen widget: queue size, active track, playback state, last capability update, and last remote media event.
                  </Text>
                  <View style={styles.diagnosticsPanel}>
                    <TextInput
                      editable
                      multiline
                      contextMenuHidden={false}
                      selectTextOnFocus
                      showSoftInputOnFocus={false}
                      style={styles.diagnosticsLog}
                      value={lockScreenDiagnostics || "No lock screen snapshot captured yet."}
                      onChangeText={() => undefined}
                    />
                  </View>
                  <Text style={styles.diagnosticsPath}>Log file: {diagnosticsPath}</Text>
                  <View style={styles.diagnosticsActions}>
                    <Pressable style={styles.secondaryButton} onPress={() => void refreshDiagnostics()}>
                      <Text style={styles.secondaryButtonText}>{diagnosticsBusy ? "Loading..." : "Refresh Log"}</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryButton} onPress={() => void handleClearDiagnostics()}>
                      <Text style={styles.secondaryButtonText}>Clear Log</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryButton} onPress={() => void shareFullDiagnosticsLog()}>
                      <Text style={styles.secondaryButtonText}>Share Log</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryButton} onPress={() => void exportDiagnosticsToDownloads()}>
                      <Text style={styles.secondaryButtonText}>{diagnosticsBusy ? "Saving..." : "Save to Downloads"}</Text>
                    </Pressable>
                  </View>
                  {diagnosticsExportNotice ? <Text style={styles.emptyStateText}>{diagnosticsExportNotice}</Text> : null}
                  <View style={styles.diagnosticsPanel}>
                    <TextInput
                      editable
                      multiline
                      contextMenuHidden={false}
                      selectTextOnFocus
                      showSoftInputOnFocus={false}
                      style={styles.diagnosticsLog}
                      value={diagnosticsLog || "No log entries yet."}
                      onChangeText={() => undefined}
                    />
                  </View>
                </View>
              </View>
            ) : null}

            {!busy && view === "settings" ? (
              <View style={styles.panel}>
                <View style={styles.topbar}>
                  <Text style={styles.pageTitle}>Settings</Text>
                  <Text style={styles.pageSubtitle}>Tune playback and diagnostics behavior for this device</Text>
                  <Text style={styles.trackSubtitle}>Current server: {normalizedServerUrl || "Not configured"}</Text>
                  <Text style={styles.trackSubtitle}>Build: {buildFingerprint}</Text>
                  <Text style={styles.trackSubtitle}>
                    Version {diagnosticsBuildInfo.appVersion} · Android vc {diagnosticsBuildInfo.androidVersionCode}
                  </Text>
                </View>

                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Playback</Text>
                  <Pressable
                    style={styles.settingsRow}
                    onPress={() => void updateKeepAwakeSetting(!keepAwakeWhilePlaying)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: keepAwakeWhilePlaying }}
                  >
                    <View style={styles.downloadCopy}>
                      <Text style={styles.trackTitle}>Keep Screen Awake</Text>
                      <Text style={styles.trackSubtitle}>Enable while audio is playing</Text>
                    </View>
                    <View style={[styles.toggleTrack, keepAwakeWhilePlaying && styles.toggleTrackActive]}>
                      <View style={[styles.toggleThumb, keepAwakeWhilePlaying && styles.toggleThumbActive]} />
                    </View>
                  </Pressable>
                </View>

                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Account</Text>
                  <Pressable
                    style={styles.settingsRow}
                    onPress={() => {
                      Alert.alert(
                        "Sign out?",
                        "This will clear the saved mobile session and return you to sign in.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Sign Out",
                            style: "destructive",
                            onPress: () => {
                              void resetSavedSession("Sign in again with your current password.");
                            }
                          }
                        ]
                      );
                    }}
                  >
                    <View style={styles.downloadCopy}>
                      <Text style={styles.trackTitle}>Sign Out</Text>
                      <Text style={styles.trackSubtitle}>Clear the saved session and sign in again</Text>
                    </View>
                  </Pressable>
                </View>

                <View style={styles.downloadSection}>
                  <Text style={styles.downloadSectionTitle}>Diagnostics</Text>
                  <Pressable
                    style={styles.settingsRow}
                    onPress={() => void updateLoggingSetting(!loggingEnabled)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: loggingEnabled }}
                  >
                    <View style={styles.downloadCopy}>
                      <Text style={styles.trackTitle}>App File Logging</Text>
                      <Text style={styles.trackSubtitle}>Store app diagnostics on this device</Text>
                    </View>
                    <View style={[styles.toggleTrack, loggingEnabled && styles.toggleTrackActive]}>
                      <View style={[styles.toggleThumb, loggingEnabled && styles.toggleThumbActive]} />
                    </View>
                  </Pressable>

                  <View style={styles.diagnosticsActions}>
                    <Pressable
                      style={[styles.secondaryButton, !loggingEnabled && styles.secondaryButtonDisabled]}
                      disabled={!loggingEnabled || diagnosticsBusy}
                      onPress={() => void refreshDiagnostics()}
                    >
                      <Text style={[styles.secondaryButtonText, !loggingEnabled && styles.secondaryButtonTextDisabled]}>
                        {diagnosticsBusy ? "Loading..." : "Refresh Log"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryButton, !loggingEnabled && styles.secondaryButtonDisabled]}
                      disabled={!loggingEnabled || diagnosticsBusy}
                      onPress={() => void copyDiagnosticsLogToClipboard()}
                    >
                      <Copy color={loggingEnabled ? theme.text : theme.muted} size={16} strokeWidth={2} />
                      <Text style={[styles.secondaryButtonText, !loggingEnabled && styles.secondaryButtonTextDisabled]}>Copy Log</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryButton, !loggingEnabled && styles.secondaryButtonDisabled]}
                      disabled={!loggingEnabled || diagnosticsBusy}
                      onPress={() => void handleClearDiagnostics()}
                    >
                      <Text style={[styles.secondaryButtonText, !loggingEnabled && styles.secondaryButtonTextDisabled]}>Clear Log</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryButton, !loggingEnabled && styles.secondaryButtonDisabled]}
                      disabled={!loggingEnabled || diagnosticsBusy}
                      onPress={() => void exportDiagnosticsToDownloads()}
                    >
                      <Text style={[styles.secondaryButtonText, !loggingEnabled && styles.secondaryButtonTextDisabled]}>
                        {diagnosticsBusy ? "Saving..." : "Save to Downloads"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryButton, (!loggingEnabled || !lastDiagnosticsExportUri) && styles.secondaryButtonDisabled]}
                      disabled={!loggingEnabled || diagnosticsBusy || !lastDiagnosticsExportUri}
                      onPress={() => void openDiagnosticsExportTarget("file")}
                    >
                      <Text
                        style={[
                          styles.secondaryButtonText,
                          (!loggingEnabled || !lastDiagnosticsExportUri) && styles.secondaryButtonTextDisabled
                        ]}
                      >
                        Open Saved File
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.secondaryButton,
                        (!loggingEnabled || (!lastDiagnosticsExportDirectoryUri && !diagnosticsExportNotice)) && styles.secondaryButtonDisabled
                      ]}
                      disabled={!loggingEnabled || diagnosticsBusy || (!lastDiagnosticsExportDirectoryUri && !diagnosticsExportNotice)}
                      onPress={() => void openDiagnosticsExportTarget("folder")}
                    >
                      <Text
                        style={[
                          styles.secondaryButtonText,
                          (!loggingEnabled || (!lastDiagnosticsExportDirectoryUri && !diagnosticsExportNotice)) &&
                            styles.secondaryButtonTextDisabled
                        ]}
                      >
                        Open Downloads Folder
                      </Text>
                    </Pressable>
                  </View>
                  {diagnosticsExportNotice ? <Text style={styles.emptyStateText}>{diagnosticsExportNotice}</Text> : null}
                  {loggingEnabled ? (
                    <View style={styles.diagnosticsPanel}>
                      <TextInput
                        editable
                        multiline
                        contextMenuHidden={false}
                        selectTextOnFocus
                        showSoftInputOnFocus={false}
                        style={styles.diagnosticsLog}
                        value={diagnosticsLog || "No log entries yet."}
                        onChangeText={() => undefined}
                      />
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}
          </ScrollView>
          )}

          {isPhone ? (
            <>
              {mobileMenuOpen ? (
                <View style={[styles.mobileMenuSheet, { bottom: mobileDockHeight - 20 }]}>
                  {safeMap(mobileMenuActions, (action) => (
                    <Pressable
                      key={action.key}
                      style={styles.mobileMenuRow}
                      onPress={() => {
                        if (action.action === "view") {
                          setView("home");
                          setMobileMenuOpen(false);
                          return;
                        }

                        if (action.action === "albums") {
                          openLibraryAlbums();
                          return;
                        }

                        if (action.action === "artists") {
                          openLibraryArtists();
                          return;
                        }

                        if (action.action === "downloads") {
                          setView("downloads");
                          setMobileMenuOpen(false);
                          return;
                        }

                        if (action.action === "liked") {
                          openLikedSongs();
                          return;
                        }

                        if (action.action === "settings") {
                          setView("settings");
                          setMobileMenuOpen(false);
                          return;
                        }

                        if (action.action === "playlists") {
                          openLibraryPlaylists();
                          return;
                        }

                        openLibraryBooks();
                      }}
                    >
                      {(() => {
                        const Icon = resolveNavIcon(action.icon);
                        return <Icon color={theme.text} size={18} strokeWidth={2.2} />;
                      })()}
                      <Text style={styles.mobileMenuLabel}>{action.label}</Text>
                    </Pressable>
                  ), "mobileMenuActions")}
                </View>
              ) : null}

              {playlistPickerState ? (
                <View style={styles.playlistPickerScrim}>
                  <View style={styles.authCard}>
                    <Text style={styles.eyebrow}>{playlistPickerState.creating ? "New Playlist" : "Add to Playlist"}</Text>
                    <Text style={styles.authTitle}>{playlistPickerState.creating ? "Create a playlist" : "Choose a playlist"}</Text>
                    <Text style={styles.authSubtitle}>
                      {playlistPickerState.creating
                        ? `Create a playlist for "${playlistPickerState.track.title ?? "track"}".`
                        : `Add "${playlistPickerState.track.title ?? "track"}" to a playlist, or create a new one.`}
                    </Text>

                    {playlistPickerState.creating ? (
                      <>
                        <TextInput
                          autoCapitalize="words"
                          editable={!playlistPickerState.busy}
                          placeholder="Playlist title"
                          placeholderTextColor={theme.muted}
                          style={styles.input}
                          value={playlistPickerState.title}
                          onChangeText={(title) =>
                            setPlaylistPickerState((previous) => (previous ? { ...previous, title, error: null } : previous))
                          }
                        />
                        {playlistPickerState.error ? <Text style={styles.errorText}>{playlistPickerState.error}</Text> : null}
                        <View style={styles.playlistPickerActions}>
                          <Pressable
                            style={styles.secondaryButton}
                            onPress={() =>
                              setPlaylistPickerState((previous) =>
                                previous ? { ...previous, creating: false, busy: false, title: "", error: null } : previous
                              )
                            }
                            disabled={playlistPickerState.busy}
                          >
                            <Text style={styles.secondaryButtonText}>Back</Text>
                          </Pressable>
                          <Pressable style={styles.primaryButton} onPress={() => void submitCreatePlaylist()} disabled={playlistPickerState.busy}>
                            <Text style={styles.primaryButtonText}>{playlistPickerState.busy ? "Saving..." : "Create"}</Text>
                          </Pressable>
                        </View>
                      </>
                    ) : (
                      <>
                        <ScrollView style={styles.playlistPickerList} contentContainerStyle={styles.playlistPickerListContent}>
                          {editablePlaylists.length > 0 ? (
                            editablePlaylists.map((playlist) => (
                              <Pressable
                                key={playlist.id}
                                style={styles.playlistPickerRow}
                                onPress={() => void addTrackToSelectedPlaylist(playlist.id)}
                                disabled={playlistPickerState.busy}
                              >
                                <View style={styles.downloadCopy}>
                                  <Text style={styles.trackTitle}>{playlist.name}</Text>
                                  <Text style={styles.trackSubtitle}>{playlist.trackCount} tracks</Text>
                                </View>
                                <ListMusic color={theme.text} size={18} strokeWidth={2} />
                              </Pressable>
                            ))
                          ) : (
                            <Text style={styles.emptyStateText}>No playlists yet. Create one to save this track.</Text>
                          )}
                        </ScrollView>
                        {playlistPickerState.error ? <Text style={styles.errorText}>{playlistPickerState.error}</Text> : null}
                        <View style={styles.playlistPickerActions}>
                          <Pressable style={styles.secondaryButton} onPress={closePlaylistPicker} disabled={playlistPickerState.busy}>
                            <Text style={styles.secondaryButtonText}>Cancel</Text>
                          </Pressable>
                          <Pressable
                            style={styles.primaryButton}
                            onPress={() =>
                              setPlaylistPickerState((previous) =>
                                previous ? { ...previous, creating: true, busy: false, title: "", error: null } : previous
                              )
                            }
                            disabled={playlistPickerState.busy}
                          >
                            <Text style={styles.primaryButtonText}>New Playlist</Text>
                          </Pressable>
                        </View>
                      </>
                    )}
                  </View>
                </View>
              ) : null}

              <View
                style={[
                  styles.mobileDock,
                  mobilePlayerExpanded && styles.mobileDockExpanded,
                  { paddingBottom: mobileBottomInset }
                ]}
              >
                {currentTrack ? (
                  <Animated.View
                    style={[
                      styles.playerBarMobile,
                      mobilePlayerExpanded && styles.playerBarMobileExpanded,
                      mobilePlayerExpanded ? { transform: [{ translateY: expandedPlayerTranslateY }] } : null
                    ]}
                  >
                  {mobilePlayerExpanded ? (
                    <View style={styles.playerExpandedHandleTouchTarget} {...expandedPlayerDismissResponder.panHandlers}>
                      <View style={styles.playerExpandedHandle} />
                    </View>
                  ) : null}
                  <View style={styles.playerCompactRow}>
                    <Pressable style={styles.playerMetaCompact} onPress={() => setMobilePlayerExpanded((previous) => !previous)}>
                      <View style={styles.playerArt}>
                        <AlbumArt
                          remoteUri={getCoverRemoteUri(currentTrack.coverArtId)}
                          offlineUri={getOfflineCoverUri(offlineLibrary, currentTrack.id, currentTrack.coverArtId)}
                          token={token}
                        />
                      </View>
                      <View style={styles.playerCompactTitleWrap}>
                        <Text style={styles.playerTitle}>{currentTrack.title ?? "Untitled track"}</Text>
                      </View>
                    </Pressable>
                    <View style={styles.playerControlsCompact}>
                      <Pressable
                        onPress={() => currentTrackIsBook ? void seekCurrentTrackBy(-20) : currentIndex > 0 && void playQueueAt(currentIndex - 1)}
                        disabled={!currentTrackIsBook && currentIndex <= 0}
                      >
                        {currentTrackIsBook ? (
                          <UndoDot color={theme.text} size={20} strokeWidth={2.2} />
                        ) : (
                          <SkipBack color={currentIndex > 0 ? theme.text : theme.muted} size={20} strokeWidth={2.2} />
                        )}
                      </Pressable>
                      <Pressable onPress={() => void togglePlayback()}>
                        {isPlaying ? <Pause color={theme.text} size={20} strokeWidth={2.4} /> : <Play color={theme.text} size={20} strokeWidth={2.4} />}
                      </Pressable>
                      <Pressable
                        onPress={() => currentTrackIsBook ? void seekCurrentTrackBy(20) : currentIndex < queue.length - 1 && void playQueueAt(currentIndex + 1)}
                        disabled={!currentTrackIsBook && currentIndex >= queue.length - 1}
                      >
                        {currentTrackIsBook ? (
                          <RedoDot color={theme.text} size={20} strokeWidth={2.2} />
                        ) : (
                          <SkipForward color={currentIndex < queue.length - 1 ? theme.text : theme.muted} size={20} strokeWidth={2.2} />
                        )}
                      </Pressable>
                      <Pressable onPress={() => currentTrack && void toggleTrackLike(currentTrack)} disabled={!currentTrack}>
                        <Heart color={currentTrackLiked ? theme.accent : theme.text} fill={currentTrackLiked ? theme.accent : "none"} size={20} strokeWidth={2.2} />
                      </Pressable>
                    </View>
                  </View>
                  {mobilePlayerExpanded ? (
                    <View style={styles.playerExpandedMeta}>
                      {currentCreatorName ? (
                        <Pressable onPress={openCurrentCreator}>
                          <Text style={styles.playerMetaLink}>{currentCreatorName}</Text>
                        </Pressable>
                      ) : null}
                      {currentCollectionName ? (
                        <Pressable onPress={() => void openCurrentCollection()}>
                          <Text style={styles.playerMetaSecondaryLink}>{currentCollectionName}</Text>
                        </Pressable>
                      ) : null}
                      {currentTrack?.bookId ? (
                        <View style={styles.playerBookSeekRow}>
                          <Pressable style={styles.playerSeekButton} onPress={() => void seekCurrentTrackBy(-20)}>
                            <UndoDot color={theme.text} size={18} strokeWidth={2.2} />
                            <Text style={styles.playerSeekLabel}>20s</Text>
                          </Pressable>
                          <Pressable style={styles.playerSeekButton} onPress={() => void seekCurrentTrackBy(20)}>
                            <RedoDot color={theme.text} size={18} strokeWidth={2.2} />
                            <Text style={styles.playerSeekLabel}>20s</Text>
                          </Pressable>
                        </View>
                      ) : null}
                      <PlaybackSeekBar position={playbackPosition} duration={playbackDuration} onSeek={(nextPositionSeconds) => void seekCurrentTrackTo(nextPositionSeconds)} />
                      {currentOfflineUri ? <Text style={styles.progressLabel}>Offline</Text> : null}
                      {upcomingQueueEntries.length > 0 ? (
                        <View style={styles.playerQueueSection}>
                          <Text style={styles.playerQueueTitle}>Up Next</Text>
                          <ScrollView style={styles.playerQueueList} nestedScrollEnabled>
                            {upcomingQueueEntries.map((entry, index) => (
                              <QueueReorderRow
                                key={`${entry.track.id}:${index}`}
                                entry={entry}
                                token={token}
                                offlineLibrary={offlineLibrary}
                                remoteUri={getCoverRemoteUri(entry.track.coverArtId)}
                                onPress={() => void playQueueAt(currentIndex + 1 + index)}
                                onRemove={() => removeQueueEntry(currentIndex + 1 + index)}
                                onMoveBy={(delta) => {
                                  const fromIndex = currentIndex + 1 + index;
                                  const toIndex = Math.max(currentIndex + 1, Math.min(queue.length - 1, fromIndex + delta));
                                  moveQueueEntry(fromIndex, toIndex);
                                }}
                              />
                            ))}
                          </ScrollView>
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                  <Text style={[styles.progressLabel, mobilePlayerExpanded && styles.progressLabelHidden]}>
                    {formatTrackTime(playbackPosition)} / {formatTrackTime(playbackDuration)} {currentOfflineUri ? "· Offline" : ""}
                  </Text>
                  </Animated.View>
                ) : null}

                <View style={styles.mobileNav}>
                  {safeMap(navigationItems, (item) => (
                    <Pressable
                      key={item.id}
                      style={styles.mobileNavButton}
                      onPress={() => {
                        setMobileMenuOpen(false);
                        if (item.id === "search") {
                          openSearchView();
                          return;
                        }

                        setView(item.id);
                      }}
                    >
                      {(() => {
                        const Icon = resolveNavIcon(item.icon);
                        return <Icon color={view === item.id ? theme.accent : theme.text} size={20} strokeWidth={2.2} />;
                      })()}
                      <Text style={[styles.mobileNavLabel, view === item.id && styles.mobileNavLabelActive]}>{item.label}</Text>
                    </Pressable>
                  ), "mobile.navigationItems")}
                  <Pressable style={styles.mobileNavButton} onPress={() => setMobileMenuOpen((previous) => !previous)}>
                    <MenuIcon color={mobileMenuOpen ? theme.accent : theme.text} size={20} strokeWidth={2.2} />
                    <Text style={[styles.mobileNavLabel, mobileMenuOpen && styles.mobileNavLabelActive]}>Menu</Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : currentTrack ? (
            <View style={styles.playerBar}>
            <View style={styles.playerMeta}>
              <View style={styles.playerArt}>
                {currentTrack ? (
                  <AlbumArt
                    remoteUri={getCoverRemoteUri(currentTrack.coverArtId)}
                    offlineUri={getOfflineCoverUri(offlineLibrary, currentTrack.id, currentTrack.coverArtId)}
                    token={token}
                  />
                ) : (
                  <View style={styles.artFallback} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.playerTitle}>{currentTrack?.title ?? "Nothing playing"}</Text>
                <Text style={styles.trackSubtitle}>{currentTrack?.artist ?? currentTrack?.author ?? "Choose an album or book"}</Text>
              </View>
            </View>
            <View style={styles.playerControls}>
              <Pressable
                onPress={() => currentTrackIsBook ? void seekCurrentTrackBy(-20) : currentIndex > 0 && void playQueueAt(currentIndex - 1)}
                disabled={!currentTrackIsBook && currentIndex <= 0}
              >
                {currentTrackIsBook ? (
                  <UndoDot color={theme.text} size={22} strokeWidth={2.2} />
                ) : (
                  <SkipBack color={currentIndex > 0 ? theme.text : theme.muted} size={22} strokeWidth={2.2} />
                )}
              </Pressable>
              <Pressable style={styles.playerMainButton} onPress={() => void togglePlayback()}>
                {isPlaying ? <Pause color="#04131a" size={20} strokeWidth={2.4} /> : <Play color="#04131a" size={20} strokeWidth={2.4} />}
              </Pressable>
              <Pressable
                onPress={() => currentTrackIsBook ? void seekCurrentTrackBy(20) : currentIndex < queue.length - 1 && void playQueueAt(currentIndex + 1)}
                disabled={!currentTrackIsBook && currentIndex >= queue.length - 1}
              >
                {currentTrackIsBook ? (
                  <RedoDot color={theme.text} size={22} strokeWidth={2.2} />
                ) : (
                  <SkipForward color={currentIndex < queue.length - 1 ? theme.text : theme.muted} size={22} strokeWidth={2.2} />
                )}
              </Pressable>
              <Pressable onPress={() => currentTrack && void toggleTrackLike(currentTrack)} disabled={!currentTrack}>
                <Heart color={currentTrackLiked ? theme.accent : theme.text} fill={currentTrackLiked ? theme.accent : "none"} size={22} strokeWidth={2.2} />
              </Pressable>
            </View>
            <Text style={styles.progressLabel}>
              {formatTrackTime(playbackPosition)} / {formatTrackTime(playbackDuration)} {currentOfflineUri ? "· Offline" : ""}
            </Text>
            </View>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
};

const SectionHeader = ({ title, subtitle, onPress }: { title: string; subtitle: string; onPress?: () => void }) => (
  <View style={styles.sectionHeader}>
    <View style={styles.sectionHeaderTopRow}>
      {onPress ? (
        <Pressable onPress={onPress} style={styles.sectionTitlePressable} accessibilityLabel={`Open ${title}`}>
          <Text style={styles.sectionTitle}>{title}</Text>
        </Pressable>
      ) : (
        <Text style={styles.sectionTitle}>{title}</Text>
      )}
      {onPress ? (
        <Pressable style={styles.sectionHeaderAction} onPress={onPress} accessibilityLabel={`Open ${title}`}>
          <ArrowRight color={theme.text} size={18} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
    <Text style={styles.sectionSubtitle}>{subtitle}</Text>
  </View>
);

const LibraryCard = ({
  item,
  token,
  singleColumn = false
}: {
  item: LibraryCardItem;
  token: string | null;
  singleColumn?: boolean;
}) => (
  <Pressable style={[styles.card, singleColumn && styles.cardSingleColumn]} onPress={item.onPress}>
    <View style={styles.cardArt}>
      <AlbumArt remoteUri={item.remoteUri} offlineUri={item.offlineUri} token={token} />
      {item.artBadge ? (
        <View style={[styles.cardArtBadgeWrap, item.artBadgeAlign === "right" && styles.cardArtBadgeWrapRight]}>
          {item.artBadge}
        </View>
      ) : null}
      {item.artCornerIcon ? (
        <View style={[styles.cardArtCornerIconWrap, item.artCornerIconAlign === "right" && styles.cardArtCornerIconWrapRight]}>
          {item.artCornerIcon}
        </View>
      ) : null}
    </View>
    {item.icon ? <View style={styles.cardStatusIcon}>{item.icon}</View> : null}
    <Text style={styles.cardTitle}>{item.title}</Text>
    <Text style={styles.cardSubtitle}>{item.subtitle}</Text>
    {item.accent ? <Text style={styles.offlineBadge}>{item.accent}</Text> : null}
  </Pressable>
);

const CardGrid = ({
  items,
  token,
  columns = 2
}: {
  items: LibraryCardItem[];
  token: string | null;
  columns?: 1 | 2;
}) => (
  <View style={[styles.cardGrid, columns === 1 && styles.cardGridSingleColumn]}>
    {safeMap(items, (item) => (
      <LibraryCard key={item.key} item={item} token={token} singleColumn={columns === 1} />
    ), "CardGrid.items")}
  </View>
);

const FeaturedEntityHero = ({
  eyebrow,
  title,
  subtitle,
  remoteUri,
  offlineUri,
  token,
  primaryLabel,
  onPrimaryPress,
  syncStatus,
  onSyncPress
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  remoteUri: string | null;
  offlineUri: string | null;
  token: string | null;
  primaryLabel: string;
  onPrimaryPress: () => void;
  syncStatus?: SyncVisualState;
  onSyncPress?: () => void;
}) => (
  <LinearGradient colors={["rgba(8,210,255,0.08)", "rgba(214,150,87,0.08)", "rgba(16,12,10,0.96)"]} style={styles.heroCard}>
    <View style={styles.heroArt}>
      <AlbumArt remoteUri={remoteUri} offlineUri={offlineUri} token={token} />
      <LinearGradient
        colors={["rgba(9,7,6,0.16)", "rgba(9,7,6,0.72)", "rgba(9,7,6,0.96)"]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.heroShade}
      />
      <LinearGradient
        colors={["rgba(9,7,6,0.92)", "rgba(9,7,6,0.56)", "rgba(9,7,6,0.12)"]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.heroShade}
      />
    </View>
    <View style={styles.heroCopy}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.heroTitle}>{title}</Text>
      <Text style={styles.heroSubtitle}>{subtitle}</Text>
      <View style={styles.heroActions}>
        <Pressable style={styles.primaryButton} onPress={onPrimaryPress}>
          <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
        </Pressable>
        {syncStatus && onSyncPress ? <SyncActionButton status={syncStatus} onPress={onSyncPress} accessibilityLabel={`${eyebrow} sync`} /> : null}
      </View>
    </View>
  </LinearGradient>
);

const SyncActionButton = ({
  status,
  onPress,
  accessibilityLabel
}: {
  status: SyncVisualState;
  onPress: () => void;
  accessibilityLabel: string;
}) => {
  const icon =
    status === "syncing" ? (
      <LoaderCircle color={theme.accent} size={18} strokeWidth={2.2} />
    ) : status === "queued" ? (
      <Clock3 color={theme.accent} size={18} strokeWidth={2} />
    ) : status === "synced" ? (
      <CloudCheck color={theme.accent} size={18} strokeWidth={2.1} />
    ) : status === "error" ? (
      <CircleAlert color={theme.danger} size={18} strokeWidth={2} />
    ) : (
      <CloudDownload color={theme.text} size={18} strokeWidth={2} />
    );

  return (
    <Pressable style={[styles.iconActionButton, status === "error" && styles.iconActionButtonError]} onPress={onPress} accessibilityLabel={accessibilityLabel}>
      {status === "syncing" ? (
        <View style={styles.syncSpinnerWrap}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        icon
      )}
    </Pressable>
  );
};

const DetailCard = ({
  entityLabel,
  title,
  subtitle,
  body,
  syncStatus,
  heroRemoteUri,
  heroOfflineUri,
  token,
  onPlay,
  primaryLabel = "Play",
  onShuffle,
  onPlayNext,
  onSync,
  onRemove,
  onRestart,
  onMarkAsRead,
  restartAccessibilityLabel,
  extraActionIcon,
  onExtraAction,
  extraActionLabel,
  heroBadgeLabel,
  trailingStatusIcons,
  children
}: {
  entityLabel: string;
  title: string;
  subtitle?: string;
  body: string;
  syncStatus?: SyncVisualState;
  heroRemoteUri?: string | null;
  heroOfflineUri?: string | null;
  token?: string | null;
  onPlay: () => void;
  primaryLabel?: string;
  onShuffle?: (() => void) | null;
  onPlayNext?: (() => void) | null;
  onSync?: (() => void) | null;
  onRemove?: (() => void) | null;
  onRestart?: (() => void) | null;
  onMarkAsRead?: (() => void) | null;
  restartAccessibilityLabel?: string;
  extraActionIcon?: ReactNode;
  onExtraAction?: (() => void) | null;
  extraActionLabel?: string;
  heroBadgeLabel?: string | null;
  trailingStatusIcons?: ReactNode[];
  children: ReactNode;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const menuEntries: {
    key: string;
    label: string;
    icon: ReactNode;
    onPress?: (() => void) | null;
    disabled?: boolean;
    destructive?: boolean;
  }[] = [];

  if (onShuffle) {
    menuEntries.push({
      key: "shuffle",
      label: `Shuffle ${entityLabel}`,
      icon: <Shuffle color={theme.text} size={16} strokeWidth={2.2} />,
      onPress: onShuffle
    });
  }

  if (onPlayNext) {
    menuEntries.push({
      key: "up-next",
      label: "Add to Up Next",
      icon: <ListEnd color={theme.text} size={16} strokeWidth={2.2} />,
      onPress: onPlayNext
    });
  }

  if (syncStatus && onSync && onRemove) {
    const syncIcon =
      syncStatus === "syncing" ? (
        <LoaderCircle color={theme.accent} size={16} strokeWidth={2.2} />
      ) : syncStatus === "queued" ? (
        <Clock3 color={theme.accent} size={16} strokeWidth={2.1} />
      ) : syncStatus === "synced" ? (
        <CloudCheck color={theme.accent} size={16} strokeWidth={2.1} />
      ) : syncStatus === "error" ? (
        <CircleAlert color={theme.danger} size={16} strokeWidth={2.1} />
      ) : (
        <CloudDownload color={theme.text} size={16} strokeWidth={2.1} />
      );

    menuEntries.push({
      key: "sync",
      label: syncStatus === "synced" ? "Remove Offline Copy" : "Sync Offline",
      icon: syncIcon,
      onPress: syncStatus === "synced" ? onRemove : onSync,
      destructive: syncStatus === "synced"
    });
  }

  if (onExtraAction && extraActionIcon) {
    menuEntries.push({
      key: "extra-status",
      label: extraActionLabel ?? `${entityLabel} status`,
      icon: extraActionIcon,
      onPress: onExtraAction
    });
  }

  if (trailingStatusIcons?.length) {
    trailingStatusIcons.forEach((icon, index) => {
      menuEntries.push({
        key: `status-${index}`,
        label: "Completed",
        icon,
        disabled: true
      });
    });
  } else if (onMarkAsRead) {
    menuEntries.push({
      key: "mark-read",
      label: "Mark as Read",
      icon: <CircleCheck color={theme.text} size={16} strokeWidth={2.2} />,
      onPress: onMarkAsRead
    });
  }

  if (onRestart) {
    menuEntries.push({
      key: "restart",
      label: entityLabel === "Book" ? "Restart Book" : "Restart",
      icon: <RotateCcw color={theme.text} size={16} strokeWidth={2.2} />,
      onPress: onRestart,
      destructive: true
    });
  }

  return (
  <View style={styles.panel}>
    <View style={[styles.detailHeader, (heroRemoteUri || heroOfflineUri) && styles.detailHeaderWithArt]}>
      {heroRemoteUri || heroOfflineUri ? (
        <View style={styles.detailHeaderArt}>
          <AlbumArt remoteUri={heroRemoteUri ?? null} offlineUri={heroOfflineUri ?? null} token={token ?? null} />
          <LinearGradient
            colors={["rgba(9,7,6,0.18)", "rgba(9,7,6,0.78)", "rgba(9,7,6,0.97)"]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={styles.detailHeaderShade}
          />
          <LinearGradient
            colors={["rgba(9,7,6,0.96)", "rgba(9,7,6,0.58)", "rgba(9,7,6,0.14)"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={styles.detailHeaderShade}
          />
        </View>
      ) : null}
      <View style={styles.detailHeaderCopy}>
        <View style={styles.detailHeaderEyebrowRow}>
          <Text style={styles.eyebrow}>{entityLabel}</Text>
          {heroBadgeLabel ? (
            <View
              style={[
                styles.detailHeaderBadge,
                heroBadgeLabel === "Completed" ? styles.detailHeaderBadgeComplete : styles.detailHeaderBadgeProgress
              ]}
            >
              <Text
                style={[
                  styles.detailHeaderBadgeText,
                  heroBadgeLabel === "Completed" ? styles.detailHeaderBadgeTextComplete : null
                ]}
              >
                {heroBadgeLabel}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.detailTitle}>{title}</Text>
        <Text style={styles.detailSubtitle}>{subtitle}</Text>
        <Text style={styles.detailBody}>{body}</Text>
      </View>
    </View>
    <View style={styles.detailActions}>
      <Pressable style={[styles.primaryButton, styles.detailPrimaryActionButton]} onPress={onPlay}>
        <Play color="#04131a" size={16} strokeWidth={2.4} />
        <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
      </Pressable>
      <View style={styles.detailActionsSpacer} />
      {menuOpen ? <Pressable style={styles.detailMenuBackdrop} onPress={() => setMenuOpen(false)} /> : null}
      {menuEntries.length > 0 ? (
        <View style={styles.detailMenuWrap}>
          <Pressable
            style={styles.iconActionButton}
            onPress={() => setMenuOpen((previous) => !previous)}
            accessibilityLabel={`${entityLabel} menu`}
          >
            <EllipsisVertical color={theme.text} size={18} strokeWidth={2.2} />
          </Pressable>
          {menuOpen ? (
            <View style={styles.detailMenuPanel}>
              {menuEntries.map((entry, index) => (
                <Pressable
                  key={entry.key}
                  style={[styles.detailMenuItem, index > 0 && styles.detailMenuItemBorder]}
                  disabled={entry.disabled}
                  onPress={() => {
                    setMenuOpen(false);
                    entry.onPress?.();
                  }}
                >
                  <View style={styles.detailMenuItemIcon}>{entry.icon}</View>
                  <Text
                    style={[
                      styles.detailMenuItemLabel
                    ]}
                  >
                    {entry.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
    <View style={styles.trackList}>{children}</View>
  </View>
  );
};

const NowPlayingGlyph = ({ animated }: { animated: boolean }) => {
  const bar1 = useRef(new Animated.Value(0.55)).current;
  const bar2 = useRef(new Animated.Value(1)).current;
  const bar3 = useRef(new Animated.Value(0.72)).current;
  const loopsRef = useRef<Animated.CompositeAnimation[]>([]);

  useEffect(() => {
    if (!animated) {
      loopsRef.current.forEach((loop) => loop.stop());
      loopsRef.current = [];
      bar1.setValue(0.55);
      bar2.setValue(1);
      bar3.setValue(0.72);
      return;
    }

    const createLoop = (value: Animated.Value, duration: number, delay: number, startValue: number) => {
      value.setValue(startValue);
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true
          }),
          Animated.timing(value, {
            toValue: 0.55,
            duration,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true
          })
        ])
      );
    };

    const nextLoops = [
      createLoop(bar1, 450, 200, 0.55),
      createLoop(bar2, 450, 450, 1),
      createLoop(bar3, 450, 650, 0.72)
    ];

    loopsRef.current = nextLoops;
    nextLoops.forEach((loop) => loop.start());

    return () => {
      nextLoops.forEach((loop) => loop.stop());
      loopsRef.current = [];
    };
  }, [animated, bar1, bar2, bar3]);

  return (
    <View style={styles.nowPlayingGlyph}>
      <Animated.View style={[styles.nowPlayingBar, styles.nowPlayingBar1, { transform: [{ scaleY: bar1 }] }]} />
      <Animated.View style={[styles.nowPlayingBar, styles.nowPlayingBar2, { transform: [{ scaleY: bar2 }] }]} />
      <Animated.View style={[styles.nowPlayingBar, styles.nowPlayingBar3, { transform: [{ scaleY: bar3 }] }]} />
    </View>
  );
};

const PlaybackSeekBar = ({
  position,
  duration,
  onSeek
}: {
  position: number;
  duration: number;
  onSeek: (nextPositionSeconds: number) => void;
}) => {
  const trackRef = useRef<View | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [trackLeft, setTrackLeft] = useState(0);
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const [pendingSeekPosition, setPendingSeekPosition] = useState<number | null>(null);
  const pendingSeekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const boundedPosition = Math.max(0, Math.min(resolvedDuration || 0, position || 0));
  const visiblePosition = dragPosition ?? pendingSeekPosition ?? boundedPosition;
  const fillFraction = resolvedDuration > 0 ? Math.max(0, Math.min(1, visiblePosition / resolvedDuration)) : 0;

  useEffect(() => {
    if (pendingSeekPosition === null) {
      return;
    }

    if (Math.abs(boundedPosition - pendingSeekPosition) <= 1.25) {
      setPendingSeekPosition(null);
      return;
    }

    return undefined;
  }, [boundedPosition, pendingSeekPosition]);

  useEffect(() => {
    return () => {
      if (pendingSeekTimeoutRef.current) {
        clearTimeout(pendingSeekTimeoutRef.current);
      }
    };
  }, []);

  const resolvePositionFromOffset = (offsetX: number) => {
    if (trackWidth <= 0 || resolvedDuration <= 0) {
      return 0;
    }

    const clampedOffset = Math.max(0, Math.min(trackWidth, offsetX));
    return (clampedOffset / trackWidth) * resolvedDuration;
  };

  const resolvePositionFromPageX = (pageX: number) => {
    return resolvePositionFromOffset(pageX - trackLeft);
  };

  const refreshTrackMetrics = () => {
    trackRef.current?.measureInWindow((x, _y, width) => {
      setTrackLeft(x);
      if (width > 0) {
        setTrackWidth(width);
      }
    });
  };

  return (
    <View style={styles.seekBarBlock}>
      <View
        ref={trackRef}
        style={styles.seekBarTrack}
        collapsable={false}
        onLayout={(event) => {
          setTrackWidth(event.nativeEvent.layout.width);
          refreshTrackMetrics();
        }}
        onStartShouldSetResponder={() => resolvedDuration > 0}
        onMoveShouldSetResponder={() => resolvedDuration > 0}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          refreshTrackMetrics();
          setDragPosition(resolvePositionFromPageX(event.nativeEvent.pageX));
        }}
        onResponderMove={(event) => {
          setDragPosition(resolvePositionFromPageX(event.nativeEvent.pageX));
        }}
        onResponderRelease={(event) => {
          const nextPositionSeconds = resolvePositionFromPageX(event.nativeEvent.pageX);
          setDragPosition(null);
          setPendingSeekPosition(nextPositionSeconds);
          if (pendingSeekTimeoutRef.current) {
            clearTimeout(pendingSeekTimeoutRef.current);
          }
          pendingSeekTimeoutRef.current = setTimeout(() => {
            setPendingSeekPosition(null);
            pendingSeekTimeoutRef.current = null;
          }, 1500);
          onSeek(nextPositionSeconds);
        }}
        onResponderTerminate={() => {
          setDragPosition(null);
        }}
      >
        <View style={[styles.seekBarFill, { width: `${fillFraction * 100}%` }]} />
        <View style={[styles.seekBarThumb, { left: `${fillFraction * 100}%` }]} />
      </View>
      <View style={styles.seekBarTimes}>
        <Text style={styles.seekBarTime}>{formatTrackTime(visiblePosition)}</Text>
        <Text style={styles.seekBarTime}>{formatTrackTime(resolvedDuration)}</Text>
      </View>
    </View>
  );
};

const TrackRow = ({
  leadingLabel,
  title,
  subtitle,
  trailing,
  isActive,
  isPlaying,
  isLiked,
  onPress,
  onToggleLike,
  onAddToPlaylist,
  onAddNextToQueue,
  onAddLastToQueue
}: {
  leadingLabel: string;
  title: string;
  subtitle: string;
  trailing: string | null;
  isActive: boolean;
  isPlaying: boolean;
  isLiked?: boolean;
  onPress: () => void;
  onToggleLike?: (() => void) | null;
  onAddToPlaylist?: (() => void) | null;
  onAddNextToQueue?: (() => void) | null;
  onAddLastToQueue?: (() => void) | null;
}) => {
  const leftActionsEnabled = Boolean(onAddNextToQueue || onAddLastToQueue);
  const rightActionsEnabled = Boolean(onToggleLike || onAddToPlaylist);
  const leftActionWidth = 116;
  const rightActionWidth = 116;
  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef<"left" | "right" | null>(null);
  const dragStartRef = useRef(0);
  const ACTION_ICON_COLOR = "rgb(14, 12, 10)";
  const [actionsVisible, setActionsVisible] = useState<"left" | "right" | null>(null);
  const SNAP_THRESHOLD = 0.84;
  const RESISTANCE_START = 0.68;
  const DRAG_RESISTANCE = 0.34;

  const applyDragResistance = (value: number) => {
    if (value < 0) {
      if (!leftActionsEnabled) {
        return 0;
      }
      const sign = -1;
      const absoluteValue = Math.abs(value);
      const resistanceStartDistance = leftActionWidth * RESISTANCE_START;
      if (absoluteValue <= resistanceStartDistance) {
        return value;
      }
      const resistedDistance =
        resistanceStartDistance + (absoluteValue - resistanceStartDistance) * DRAG_RESISTANCE;
      return sign * Math.min(leftActionWidth, resistedDistance);
    }

    if (value > 0) {
      if (!rightActionsEnabled) {
        return 0;
      }
      const resistanceStartDistance = rightActionWidth * RESISTANCE_START;
      if (value <= resistanceStartDistance) {
        return value;
      }
      const resistedDistance =
        resistanceStartDistance + (value - resistanceStartDistance) * DRAG_RESISTANCE;
      return Math.min(rightActionWidth, resistedDistance);
    }

    return 0;
  };

  const animateRow = (toValue: number) => {
    Animated.spring(translateX, {
      toValue,
      stiffness: 220,
      damping: 24,
      mass: 0.9,
      useNativeDriver: true
    }).start(() => {
      openRef.current = toValue < 0 ? "left" : toValue > 0 ? "right" : null;
    });
  };

  const closeRow = () => {
    animateRow(0);
  };

  useEffect(() => {
    if (isActive) {
      translateX.stopAnimation();
      translateX.setValue(0);
      openRef.current = null;
      dragStartRef.current = 0;
      setActionsVisible(null);
    }
  }, [isActive, translateX]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        (leftActionsEnabled || rightActionsEnabled) &&
        Math.abs(gestureState.dx) > 6 &&
        Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
      onPanResponderGrant: () => {
        setActionsVisible(openRef.current);
        translateX.stopAnimation((value) => {
          dragStartRef.current = value;
        });
      },
      onPanResponderMove: (_, gestureState) => {
        const nextValue = dragStartRef.current + gestureState.dx;
        const resistedValue = applyDragResistance(nextValue);
        setActionsVisible(resistedValue < 0 ? "left" : resistedValue > 0 ? "right" : null);
        translateX.setValue(resistedValue);
      },
      onPanResponderRelease: (_, gestureState) => {
        const rawValue = dragStartRef.current + gestureState.dx;
        const visibleValue = applyDragResistance(rawValue);
        const shouldOpenLeft = leftActionsEnabled && visibleValue <= -(leftActionWidth * SNAP_THRESHOLD);
        const shouldOpenRight = rightActionsEnabled && visibleValue >= rightActionWidth * SNAP_THRESHOLD;
        const nextSnapValue = shouldOpenLeft ? -leftActionWidth : shouldOpenRight ? rightActionWidth : 0;
        setActionsVisible(nextSnapValue < 0 ? "left" : nextSnapValue > 0 ? "right" : null);
        animateRow(nextSnapValue);
      },
      onPanResponderTerminate: () => {
        setActionsVisible(openRef.current);
        animateRow(openRef.current === "left" ? -leftActionWidth : openRef.current === "right" ? rightActionWidth : 0);
      }
    })
  ).current;

  const content = (
    <>
      <View style={styles.trackLeadingSlot}>
        {isActive ? <NowPlayingGlyph animated={isPlaying} /> : <Text style={styles.trackLeadingLabel}>{leadingLabel}</Text>}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.trackTitle}>{truncateTrackLabel(title)}</Text>
        {subtitle ? <Text style={styles.trackSubtitle}>{subtitle}</Text> : null}
      </View>
      {onToggleLike ? (
        <Pressable
          style={styles.trackLikeButton}
          onPress={(event) => {
            event.stopPropagation();
            onToggleLike();
          }}
          accessibilityLabel={isLiked ? "Remove from liked songs" : "Add to liked songs"}
        >
          <Heart color={isLiked ? theme.accent : theme.text} fill={isLiked ? theme.accent : "none"} size={16} strokeWidth={2.1} />
        </Pressable>
      ) : null}
      {trailing ? (
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.trackTime}>{trailing}</Text>
        </View>
      ) : null}
    </>
  );

  if (!leftActionsEnabled && !rightActionsEnabled) {
    return (
      <Pressable style={[styles.trackRow, isActive && styles.trackRowActive]} onPress={onPress}>
        {content}
      </Pressable>
    );
  }

  return (
    <View style={styles.trackRowSwipeWrap}>
      <View style={[styles.trackRowActionsLeft, actionsVisible !== "left" && styles.trackRowActionsHidden]}>
        {onAddNextToQueue ? (
          <Pressable
            style={styles.trackRowActionButton}
            onPress={() => {
              closeRow();
              setActionsVisible(null);
              onAddNextToQueue();
            }}
            accessibilityLabel="Add track to next position in queue"
          >
            <ListStart color={ACTION_ICON_COLOR} size={18} strokeWidth={2.1} />
          </Pressable>
        ) : null}
        {onAddLastToQueue ? (
          <Pressable
            style={styles.trackRowActionButton}
            onPress={() => {
              closeRow();
              setActionsVisible(null);
              onAddLastToQueue();
            }}
            accessibilityLabel="Add track to end of queue"
          >
            <ListEnd color={ACTION_ICON_COLOR} size={18} strokeWidth={2.1} />
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.trackRowActionsRight, actionsVisible !== "right" && styles.trackRowActionsHidden]}>
        {onAddToPlaylist ? (
          <Pressable
            style={styles.trackRowActionButton}
            onPress={() => {
              closeRow();
              setActionsVisible(null);
              onAddToPlaylist();
            }}
            accessibilityLabel="Add track to playlist"
          >
            <ListMusic color={ACTION_ICON_COLOR} size={18} strokeWidth={2.1} />
          </Pressable>
        ) : null}
        {onToggleLike ? (
          <Pressable
            style={styles.trackRowActionButton}
            onPress={() => {
              closeRow();
              setActionsVisible(null);
              onToggleLike();
            }}
            accessibilityLabel={isLiked ? "Remove from liked songs" : "Add to liked songs"}
          >
            <Heart color={ACTION_ICON_COLOR} fill={isLiked ? ACTION_ICON_COLOR : "none"} size={18} strokeWidth={2.1} />
          </Pressable>
        ) : null}
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <Pressable
          style={[styles.trackRow, styles.trackRowSwipeSurface, isActive && styles.trackRowActive]}
          onPress={() => {
            if (openRef.current) {
              closeRow();
              setActionsVisible(null);
              return;
            }

            closeRow();
            setActionsVisible(null);
            onPress();
          }}
        >
          {content}
        </Pressable>
      </Animated.View>
    </View>
  );
};

const QueueReorderRow = ({
  entry,
  token,
  offlineLibrary,
  remoteUri,
  onPress,
  onRemove,
  onMoveBy
}: {
  entry: QueueEntry;
  token: string | null;
  offlineLibrary: OfflineLibraryState;
  remoteUri: string | null;
  onPress: () => void;
  onRemove: () => void;
  onMoveBy: (delta: number) => void;
}) => {
  const translateY = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const openRef = useRef(false);
  const rowHeight = 58;
  const swipeWidth = 72;

  const closeRow = () => {
    openRef.current = false;
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6
    }).start();
  };

  const reorderResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dy) > 8 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onMoveShouldSetPanResponderCapture: (_, gestureState) => Math.abs(gestureState.dy) > 4 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          setIsDragging(true);
          translateY.setValue(0);
        },
        onPanResponderMove: (_, gestureState) => {
          translateY.setValue(gestureState.dy);
        },
        onPanResponderRelease: (_, gestureState) => {
          const moveBy = Math.round(gestureState.dy / rowHeight);
          translateY.setValue(0);
          setIsDragging(false);
          if (moveBy !== 0) {
            onMoveBy(moveBy);
          }
        },
        onPanResponderTerminate: () => {
          translateY.setValue(0);
          setIsDragging(false);
        }
      }),
    [onMoveBy, translateY]
  );

  const swipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dx) > 8 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          setDeleteVisible(true);
        },
        onPanResponderMove: (_, gestureState) => {
          const nextOffset = openRef.current ? gestureState.dx - swipeWidth : gestureState.dx;
          translateX.setValue(Math.max(-swipeWidth, Math.min(swipeWidth, nextOffset)));
        },
        onPanResponderRelease: (_, gestureState) => {
          const shouldOpen = Math.abs(gestureState.dx) > 28;
          openRef.current = shouldOpen;
          Animated.spring(translateX, {
            toValue: shouldOpen ? (gestureState.dx < 0 ? -swipeWidth : swipeWidth) : 0,
            useNativeDriver: true,
            speed: 18,
            bounciness: 6
          }).start(() => {
            if (!shouldOpen) {
              setDeleteVisible(false);
            }
          });
        },
        onPanResponderTerminate: () => {
          closeRow();
          setDeleteVisible(false);
        }
      }),
    [translateX]
  );

  return (
    <Animated.View style={[styles.queueRowWrap, isDragging && styles.queueRowWrapDragging, { transform: [{ translateY }] }]}>
      <View style={[styles.queueRowDeleteActions, !deleteVisible && styles.trackRowActionsHidden]}>
        <Pressable
          style={styles.queueRowDeleteButton}
          onPress={() => {
            closeRow();
            setDeleteVisible(false);
            onRemove();
          }}
          accessibilityLabel="Remove track from queue"
        >
          <Trash2 color={theme.text} size={18} strokeWidth={2.1} />
        </Pressable>
      </View>
      <Animated.View style={[styles.queueRow, { transform: [{ translateX }] }]} {...swipeResponder.panHandlers}>
        <Pressable
          style={styles.queueRowPressable}
          onPress={() => {
            if (openRef.current) {
              closeRow();
              setDeleteVisible(false);
              return;
            }

            onPress();
          }}
        >
          <View style={styles.queueArt}>
            <AlbumArt
              remoteUri={remoteUri}
              offlineUri={getOfflineCoverUri(offlineLibrary, entry.track.id, entry.track.coverArtId)}
              token={token}
            />
          </View>
          <Text style={styles.queueTitle}>{truncateQueueLabel(entry.track.title ?? "Untitled track")}</Text>
        </Pressable>
        <View style={styles.queueHandle} {...reorderResponder.panHandlers}>
          <GripVertical color={theme.muted} size={18} strokeWidth={2.1} />
        </View>
      </Animated.View>
    </Animated.View>
  );
};

const AlbumArt = ({
  remoteUri,
  offlineUri,
  token
}: {
  remoteUri: string | null;
  offlineUri: string | null;
  token: string | null;
}) => {
  if (offlineUri) {
    return <Image source={{ uri: offlineUri }} style={styles.artImage} />;
  }

  if (remoteUri) {
    return <Image source={{ uri: remoteUri, headers: token ? { Authorization: `Bearer ${token}` } : undefined }} style={styles.artImage} />;
  }

  return <View style={styles.artFallback} />;
};

function App() {
  useEffect(() => {
    const buildInfo = getDiagnosticsBuildInfo();
    const logSessionContext = {
      ...buildInfo,
      platform: Platform.OS,
      platformVersion: Platform.Version
    };

    setAppLogSessionContext(logSessionContext);

    void logInfo("Android app launched", {
      ...logSessionContext,
      logContextApplied: true
    });

    const root = globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
        setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      };
    };

    const previousHandler = root.ErrorUtils?.getGlobalHandler?.();

    root.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
      void logError("Global JavaScript error captured", error, { isFatal: Boolean(isFatal) });
      previousHandler?.(error, isFatal);
    });

    return () => {
      if (previousHandler) {
        root.ErrorUtils?.setGlobalHandler?.(previousHandler);
      }
    };
  }, []);

  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <AppBody />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

export default App;

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
  logContents: string;
  errorStack: string;
  componentStack: string;
  shareNotice: string;
};

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: "",
    logContents: "",
    errorStack: "",
    componentStack: "",
    shareNotice: ""
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "Unknown render failure",
      logContents: "",
      errorStack: error.stack ?? "",
      componentStack: "",
      shareNotice: ""
    };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    void logError("React render failure captured", error, {
      componentStack: info.componentStack
    });

    this.setState({
      errorStack: error.stack ?? "",
      componentStack: info.componentStack
    });

    void readAppLog()
      .then((contents) => {
        this.setState({ logContents: formatDiagnosticsPreview(contents) });
      })
      .catch(() => undefined);
  }

  shareText = async (value: string, label: string) => {
    try {
      await Share.share({ message: value });
      this.setState({ shareNotice: `${label} opened in the Android share sheet.` });
    } catch {
      this.setState({ shareNotice: `Could not share ${label.toLowerCase()}.` });
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.authBackground}>
          <View style={styles.authCard}>
            <Text style={styles.eyebrow}>Diagnostics</Text>
            <Text style={styles.authTitle}>The app hit a recoverable rendering error.</Text>
            <Text style={styles.authSubtitle}>
              Android keeps this log in the app's private storage, so it will not appear in the Files app. The latest captured diagnostics are shown below.
            </Text>
            <TextInput
              editable
              multiline
              contextMenuHidden={false}
              selectTextOnFocus
              showSoftInputOnFocus={false}
              style={styles.errorTextInput}
              value={this.state.message}
              onChangeText={() => undefined}
            />
            <Text style={styles.diagnosticsPath}>Log file: {APP_LOG_FILE_PATH}</Text>
            <View style={styles.diagnosticsActions}>
              <Pressable style={styles.secondaryButton} onPress={() => void this.shareText(this.state.message, "Error text")}>
                <Text style={styles.secondaryButtonText}>Share Error</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => void this.shareText(this.state.errorStack || this.state.message, "Error stack")}
              >
                <Text style={styles.secondaryButtonText}>Share Stack</Text>
              </Pressable>
            </View>
            {this.state.shareNotice ? <Text style={styles.emptyStateText}>{this.state.shareNotice}</Text> : null}
            {this.state.errorStack ? (
              <View style={styles.diagnosticsPanel}>
                <TextInput
                  editable
                  multiline
                  contextMenuHidden={false}
                  selectTextOnFocus
                  showSoftInputOnFocus={false}
                  style={styles.diagnosticsLog}
                  value={this.state.errorStack}
                  onChangeText={() => undefined}
                />
              </View>
            ) : null}
            {this.state.componentStack ? (
              <View style={styles.diagnosticsPanel}>
                <TextInput
                  editable
                  multiline
                  contextMenuHidden={false}
                  selectTextOnFocus
                  showSoftInputOnFocus={false}
                  style={styles.diagnosticsLog}
                  value={this.state.componentStack}
                  onChangeText={() => undefined}
                />
              </View>
            ) : null}
            <View style={styles.diagnosticsPanel}>
              <TextInput
                editable
                multiline
                contextMenuHidden={false}
                selectTextOnFocus
                showSoftInputOnFocus={false}
                style={styles.diagnosticsLog}
                value={this.state.logContents || "No diagnostics were captured before this error screen rendered."}
                onChangeText={() => undefined}
              />
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.bg
  },
  authBackground: {
    flex: 1,
    justifyContent: "center",
    padding: 20
  },
  authCard: {
    backgroundColor: "rgba(24,18,14,0.98)",
    borderColor: theme.line,
    borderRadius: 28,
    borderWidth: 1,
    padding: 22,
    gap: 12
  },
  authTitle: {
    color: theme.text,
    fontSize: 30,
    fontWeight: "700"
  },
  authSubtitle: {
    color: theme.muted,
    fontSize: 15,
    lineHeight: 22
  },
  input: {
    backgroundColor: theme.panel2,
    borderColor: theme.line,
    borderRadius: 16,
    borderWidth: 1,
    color: theme.text,
    paddingHorizontal: 14,
    paddingVertical: 14
  },
  errorText: {
    color: theme.danger
  },
  playlistPickerScrim: {
    backgroundColor: "rgba(5, 4, 3, 0.76)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    padding: 20,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 12
  },
  playlistPickerList: {
    maxHeight: 280
  },
  playlistPickerListContent: {
    gap: 10
  },
  playlistPickerRow: {
    alignItems: "center",
    backgroundColor: theme.panel2,
    borderColor: theme.line,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 14
  },
  playlistPickerActions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 4
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: theme.accent,
    borderRadius: 999,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 14
  },
  primaryButtonText: {
    color: "#04131a",
    fontWeight: "700"
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: theme.line,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 13
  },
  secondaryButtonDisabled: {
    opacity: 0.52
  },
  secondaryButtonText: {
    color: theme.text,
    fontWeight: "600"
  },
  secondaryButtonTextDisabled: {
    color: theme.muted
  },
  iconActionButton: {
    alignItems: "center",
    backgroundColor: theme.panel2,
    borderColor: theme.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 46,
    justifyContent: "center",
    width: 46
  },
  iconActionButtonSuccess: {
    backgroundColor: "rgba(8, 210, 255, 0.14)",
    borderColor: theme.accent
  },
  iconActionButtonError: {
    backgroundColor: "rgba(220, 72, 72, 0.14)",
    borderColor: theme.danger
  },
  syncSpinnerWrap: {
    alignItems: "center",
    justifyContent: "center"
  },
  textButton: {
    alignItems: "center",
    paddingVertical: 4
  },
  textButtonLabel: {
    color: theme.accent
  },
  appShell: {
    flex: 1,
    flexDirection: "row"
  },
  sidebar: {
    width: 220,
    backgroundColor: "#161210",
    borderRightColor: theme.line,
    borderRightWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 20,
    paddingBottom: 16,
    gap: 8
  },
  brandRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginBottom: 12
  },
  brandIconWrap: {
    alignItems: "center",
    backgroundColor: theme.panel2,
    borderColor: theme.line,
    borderRadius: 10,
    borderWidth: 1,
    height: 30,
    justifyContent: "center",
    width: 30
  },
  brand: {
    color: theme.text,
    fontSize: 24,
    fontWeight: "700"
  },
  navButton: {
    alignItems: "center",
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12
  },
  navButtonActive: {
    backgroundColor: theme.accent
  },
  navButtonLabel: {
    color: theme.text,
    fontWeight: "600"
  },
  navButtonLabelActive: {
    color: "#04131a"
  },
  sidebarFooter: {
    marginTop: "auto"
  },
  sidebarMeta: {
    color: theme.muted
  },
  mainPane: {
    flex: 1
  },
  restoreScreen: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 24
  },
  scrollContent: {
    padding: 16,
    gap: 18
  },
  albumListContent: {
    gap: 0
  },
  albumListHeader: {
    gap: 18,
    marginBottom: 18
  },
  albumListRow: {
    gap: 12,
    justifyContent: "space-between",
    marginBottom: 12
  },
  albumGridCell: {
    flex: 1,
    maxWidth: "48%"
  },
  albumGridCellTablet: {
    maxWidth: "31.8%"
  },
  statusNotice: {
    alignItems: "center",
    backgroundColor: "rgba(14, 24, 28, 0.92)",
    borderColor: theme.line,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  statusNoticeText: {
    color: theme.text,
    flex: 1,
    fontSize: 13,
    lineHeight: 18
  },
  topbar: {
    gap: 16
  },
  searchTopbar: {
    marginBottom: 8
  },
  eyebrow: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase"
  },
  pageTitle: {
    color: theme.text,
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 38,
    marginTop: 4
  },
  pageSubtitle: {
    color: theme.muted,
    fontSize: 15,
    lineHeight: 22
  },
  searchInput: {
    backgroundColor: theme.panel2,
    borderColor: theme.line,
    borderRadius: 999,
    borderWidth: 1,
    color: theme.text,
    paddingHorizontal: 16,
    paddingVertical: 13
  },
  loadingCard: {
    alignItems: "center",
    backgroundColor: theme.panel,
    borderRadius: 24,
    gap: 10,
    padding: 24
  },
  restoreText: {
    color: theme.muted,
    fontSize: 14
  },
  heroCard: {
    borderColor: theme.line,
    borderRadius: 28,
    borderWidth: 1,
    minHeight: 240,
    overflow: "hidden",
    padding: 22
  },
  heroArt: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#0c0908"
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject
  },
  heroCopy: {
    flex: 1,
    justifyContent: "space-between",
    position: "relative",
    zIndex: 1
  },
  heroTitle: {
    color: theme.text,
    fontSize: 36,
    fontWeight: "700",
    lineHeight: 38,
    marginTop: 8
  },
  heroSubtitle: {
    color: theme.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    maxWidth: 480
  },
  heroSyncStatus: {
    color: theme.muted,
    marginTop: 10
  },
  heroActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 20
  },
  sectionHeader: {
    marginTop: 6
  },
  sectionHeaderTopRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingRight: 6
  },
  sectionTitlePressable: {
    flex: 1
  },
  sectionHeaderAction: {
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
    paddingLeft: 12,
    paddingVertical: 2
  },
  sectionTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "700"
  },
  sectionSubtitle: {
    color: theme.muted,
    marginTop: 4
  },
  cardGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    justifyContent: "space-between"
  },
  cardGridSingleColumn: {
    flexDirection: "column",
    flexWrap: "nowrap"
  },
  card: {
    backgroundColor: "transparent",
    borderRadius: 22,
    minWidth: 160,
    width: "48%"
  },
  cardSingleColumn: {
    width: "100%"
  },
  cardArt: {
    aspectRatio: 1,
    borderColor: theme.line,
    borderRadius: 22,
    borderWidth: 1,
    marginBottom: 10,
    overflow: "hidden"
  },
  cardArtBadgeWrap: {
    left: 10,
    position: "absolute",
    top: 10
  },
  cardArtBadgeWrapRight: {
    left: undefined,
    right: 10
  },
  cardArtBadge: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(12, 9, 8, 0.88)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  cardArtBadgeProgress: {
    backgroundColor: "rgba(12, 9, 8, 0.88)"
  },
  cardArtBadgeComplete: {
    backgroundColor: "#65d46e",
    borderColor: "#65d46e"
  },
  cardArtBadgeText: {
    color: theme.text,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.1
  },
  cardArtBadgeTextComplete: {
    color: "#0f130f"
  },
  cardArtCornerIconWrap: {
    alignItems: "center",
    backgroundColor: "rgba(12, 9, 8, 0.82)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    borderWidth: 1,
    bottom: 10,
    justifyContent: "center",
    left: 10,
    padding: 6,
    position: "absolute"
  },
  cardArtCornerIconWrapRight: {
    left: undefined,
    right: 10
  },
  cardTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "400"
  },
  cardStatusIcon: {
    alignSelf: "flex-end",
    marginBottom: 6
  },
  cardSubtitle: {
    color: theme.muted,
    marginTop: 4
  },
  offlineBadge: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 6
  },
  segmentRow: {
    backgroundColor: theme.panel,
    borderRadius: 18,
    flexDirection: "row",
    gap: 8,
    padding: 6
  },
  segmentButton: {
    alignItems: "center",
    borderRadius: 14,
    flex: 1,
    paddingVertical: 12
  },
  segmentButtonActive: {
    backgroundColor: theme.accentSoft
  },
  segmentLabel: {
    color: theme.muted,
    fontWeight: "600"
  },
  segmentLabelActive: {
    color: theme.text
  },
  panel: {
    paddingHorizontal: 6,
    paddingVertical: 4
  },
  detailHeader: {
    overflow: "hidden"
  },
  detailHeaderWithArt: {
    borderRadius: 22,
    marginHorizontal: -6,
    marginTop: -6,
    minHeight: 220,
    paddingHorizontal: 18,
    paddingVertical: 18,
    position: "relative"
  },
  detailHeaderArt: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#0c0908"
  },
  detailHeaderEyebrowRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  detailHeaderBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  detailHeaderBadgeProgress: {
    backgroundColor: "rgba(12, 10, 9, 0.84)",
    borderColor: "rgba(201, 133, 74, 0.42)"
  },
  detailHeaderBadgeComplete: {
    backgroundColor: "#65d46e",
    borderColor: "#65d46e"
  },
  detailHeaderBadgeText: {
    color: theme.text,
    fontSize: 12,
    fontWeight: "700"
  },
  detailHeaderBadgeTextComplete: {
    color: "#0f130f"
  },
  detailHeaderShade: {
    ...StyleSheet.absoluteFillObject
  },
  detailHeaderCopy: {
    position: "relative",
    zIndex: 1
  },
  downloadSection: {
    gap: 12,
    marginTop: 18
  },
  downloadSectionTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700"
  },
  downloadRow: {
    alignItems: "center",
    backgroundColor: theme.panel2,
    borderRadius: 18,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12
  },
  settingsRow: {
    alignItems: "center",
    backgroundColor: theme.panel2,
    borderColor: theme.line,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 14
  },
  toggleTrack: {
    backgroundColor: theme.panel3,
    borderColor: theme.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 28,
    justifyContent: "center",
    paddingHorizontal: 3,
    width: 50
  },
  toggleTrackActive: {
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent
  },
  toggleThumb: {
    backgroundColor: theme.muted,
    borderRadius: 999,
    height: 20,
    width: 20
  },
  toggleThumbActive: {
    alignSelf: "flex-end",
    backgroundColor: theme.accent
  },
  downloadArt: {
    borderRadius: 14,
    height: 44,
    overflow: "hidden",
    width: 44
  },
  downloadStatusIcon: {
    alignItems: "center",
    justifyContent: "center",
    width: 20
  },
  downloadCopy: {
    flex: 1
  },
  emptyStateText: {
    color: theme.muted,
    lineHeight: 20
  },
  diagnosticsActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  diagnosticsPath: {
    color: theme.muted,
    fontSize: 12,
    lineHeight: 18
  },
  diagnosticsPanel: {
    backgroundColor: "#0d0a09",
    borderColor: theme.line,
    borderRadius: 16,
    borderWidth: 1,
    maxHeight: 260,
    padding: 12
  },
  diagnosticsLog: {
    color: theme.text,
    fontFamily: Platform.select({ android: "monospace", default: undefined }),
    fontSize: 12,
    lineHeight: 18,
    padding: 0,
    textAlignVertical: "top"
  },
  errorTextInput: {
    color: theme.danger,
    fontSize: 18,
    lineHeight: 24,
    padding: 0,
    textAlignVertical: "top"
  },
  syncErrorText: {
    color: theme.danger
  },
  detailTitle: {
    color: theme.text,
    fontSize: 28,
    fontWeight: "700",
    marginTop: 6
  },
  detailSubtitle: {
    color: theme.muted,
    marginTop: 4
  },
  detailBody: {
    color: theme.muted,
    lineHeight: 22,
    marginTop: 12
  },
  detailSyncState: {
    color: theme.accent,
    fontWeight: "600",
    marginTop: 12
  },
  detailSyncStateError: {
    color: theme.danger
  },
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
    position: "relative"
  },
  detailActionsSpacer: {
    flex: 1
  },
  detailMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10
  },
  detailMenuWrap: {
    position: "relative",
    zIndex: 21
  },
  detailMenuPanel: {
    backgroundColor: "#2a2520",
    borderColor: theme.line,
    borderRadius: 18,
    borderWidth: 1,
    minWidth: 220,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: 54,
    zIndex: 20
  },
  detailMenuItem: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13
  },
  detailMenuItemBorder: {
    borderTopColor: theme.line,
    borderTopWidth: 1
  },
  detailMenuItemIcon: {
    alignItems: "center",
    justifyContent: "center",
    width: 20
  },
  detailMenuItemLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "600"
  },
  trackList: {
    marginTop: 18
  },
  trackRowSwipeWrap: {
    overflow: "hidden",
    position: "relative"
  },
  trackRowActionsLeft: {
    alignItems: "center",
    backgroundColor: "#00c8e0",
    bottom: 0,
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-end",
    paddingRight: 8,
    position: "absolute",
    right: 0,
    top: 0,
    width: 116
  },
  trackRowActionsRight: {
    alignItems: "center",
    backgroundColor: "#00c8e0",
    bottom: 0,
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-start",
    left: 0,
    paddingLeft: 8,
    position: "absolute",
    top: 0,
    width: 116
  },
  trackRowActionsHidden: {
    opacity: 0
  },
  trackRowActionButton: {
    alignItems: "center",
    backgroundColor: "#00c8e0",
    borderColor: "#00c8e0",
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  trackRow: {
    alignItems: "center",
    borderBottomColor: theme.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 0,
    paddingVertical: 12
  },
  trackRowSwipeSurface: {
    backgroundColor: "#14100e"
  },
  trackRowActive: {
    backgroundColor: "rgba(35, 27, 22, 0.45)"
  },
  trackLeadingSlot: {
    alignItems: "center",
    justifyContent: "center",
    width: 24
  },
  trackLeadingLabel: {
    color: theme.muted,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
    width: "100%"
  },
  nowPlayingGlyph: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 2,
    height: 16,
    justifyContent: "center",
    width: 16
  },
  nowPlayingBar: {
    backgroundColor: theme.accent,
    borderRadius: 999,
    transformOrigin: "center bottom"
  },
  nowPlayingBar1: {
    height: 8,
    width: 2
  },
  nowPlayingBar2: {
    height: 12,
    width: 2
  },
  nowPlayingBar3: {
    height: 10,
    width: 2
  },
  trackTitle: {
    color: theme.text,
    fontWeight: "600"
  },
  trackSubtitle: {
    color: theme.muted,
    marginTop: 3
  },
  trackTime: {
    color: theme.text,
    fontVariant: ["tabular-nums"]
  },
  trackLikeButton: {
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
    minHeight: 28,
    minWidth: 28
  },
  searchRow: {
    alignItems: "center",
    borderBottomColor: theme.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14
  },
  searchHistoryList: {
    marginTop: 8
  },
  searchResultsList: {
    marginTop: 8
  },
  searchTermRow: {
    borderBottomColor: theme.line,
    borderBottomWidth: 1,
    paddingVertical: 14
  },
  searchArt: {
    borderColor: theme.line,
    borderRadius: 14,
    borderWidth: 1,
    height: 52,
    overflow: "hidden",
    width: 52
  },
  searchCopy: {
    flex: 1,
    minWidth: 0
  },
  searchMetaRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4
  },
  searchMetaDot: {
    color: theme.muted
  },
  playerBar: {
    backgroundColor: "rgba(24,18,14,0.98)",
    borderTopColor: theme.line,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 20,
    position: "absolute",
    right: 0
  },
  playerBarMobile: {
    backgroundColor: "#2a2520",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6
  },
  playerBarMobileExpanded: {
    backgroundColor: "#2a2520",
    paddingTop: 4
  },
  playerCompactRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  playerMeta: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  playerMetaCompact: {
    alignItems: "center",
    flexDirection: "row",
    flex: 1,
    gap: 10
  },
  playerCompactTitleWrap: {
    flex: 1,
    minWidth: 0
  },
  playerArt: {
    borderRadius: 14,
    height: 40,
    overflow: "hidden",
    width: 40
  },
  artImage: {
    height: "100%",
    width: "100%"
  },
  artFallback: {
    backgroundColor: theme.panel3,
    height: "100%",
    width: "100%"
  },
  playerTitle: {
    color: theme.text,
    fontWeight: "700"
  },
  playerControls: {
    alignItems: "center",
    flexDirection: "row",
    gap: 22,
    justifyContent: "center",
    marginTop: 14
  },
  playerControlsCompact: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    justifyContent: "flex-end"
  },
  playerMainButton: {
    alignItems: "center",
    backgroundColor: theme.accent,
    borderRadius: 999,
    height: 52,
    justifyContent: "center",
    width: 52
  },
  playerMainButtonCompact: {
    alignItems: "center",
    backgroundColor: theme.accent,
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  playerExpandButton: {
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2
  },
  playerExpandedMeta: {
    backgroundColor: "#2a2520",
    gap: 4,
    marginTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 0,
    paddingTop: 0
  },
  playerExpandedHandleTouchTarget: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 26,
    paddingBottom: 6,
    paddingTop: 2
  },
  playerExpandedHandle: {
    backgroundColor: "rgba(241, 234, 224, 0.5)",
    borderRadius: 999,
    height: 4,
    width: 56
  },
  playerBookSeekRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8
  },
  playerMetaLink: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "700"
  },
  playerMetaSecondaryLink: {
    color: theme.muted,
    fontSize: 13
  },
  playerSeekButton: {
    alignItems: "center",
    borderColor: theme.line,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  playerSeekLabel: {
    color: theme.text,
    fontSize: 12,
    fontWeight: "700"
  },
  seekBarBlock: {
    gap: 8,
    marginTop: 10
  },
  seekBarTrack: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    height: 6,
    justifyContent: "center",
    overflow: "visible",
    position: "relative"
  },
  seekBarFill: {
    backgroundColor: theme.accent,
    borderRadius: 999,
    height: 6
  },
  seekBarThumb: {
    backgroundColor: theme.text,
    borderColor: "#04131a",
    borderRadius: 999,
    borderWidth: 2,
    height: 16,
    marginLeft: -8,
    position: "absolute",
    top: -5,
    width: 16
  },
  seekBarTimes: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  seekBarTime: {
    color: theme.muted,
    fontSize: 12
  },
  progressLabel: {
    color: theme.muted,
    marginTop: 6,
    textAlign: "left"
  },
  progressLabelHidden: {
    display: "none"
  },
  playerQueueSection: {
    marginTop: 12
  },
  playerQueueTitle: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8
  },
  playerQueueList: {
    maxHeight: 348,
    paddingRight: 8
  },
  queueRowWrap: {
    overflow: "hidden",
    position: "relative"
  },
  queueRowWrapDragging: {
    elevation: 12,
    overflow: "visible",
    zIndex: 20
  },
  queueRowDeleteActions: {
    alignItems: "center",
    backgroundColor: "rgba(112, 49, 49, 0.88)",
    bottom: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingRight: 10,
    position: "absolute",
    right: 0,
    top: 0,
    width: 84
  },
  queueRowDeleteButton: {
    alignItems: "center",
    backgroundColor: "rgba(112, 49, 49, 0.96)",
    borderColor: "rgba(142, 72, 72, 0.96)",
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  queueRow: {
    alignItems: "center",
    backgroundColor: "#2a2520",
    borderBottomColor: theme.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    minHeight: 58
  },
  queueRowPressable: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 10
  },
  queueArt: {
    borderRadius: 10,
    height: 34,
    overflow: "hidden",
    width: 34
  },
  queueTitle: {
    color: theme.text,
    flex: 1,
    fontSize: 13,
    fontWeight: "600"
  },
  queueHandle: {
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    paddingHorizontal: 6,
    paddingVertical: 10
  },
  mobileDock: {
    backgroundColor: "rgba(11,9,8,0.96)",
    borderTopColor: theme.line,
    borderTopWidth: 1,
    bottom: 0,
    gap: 6,
    left: 0,
    paddingHorizontal: 12,
    paddingTop: 12,
    position: "absolute",
    right: 0
  },
  mobileDockExpanded: {
    backgroundColor: "transparent",
    borderTopWidth: 0
  },
  mobileNav: {
    backgroundColor: "rgba(17,13,11,0.95)",
    borderColor: theme.line,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 10
  },
  mobileNavButton: {
    alignItems: "center",
    flex: 1,
    gap: 4
  },
  mobileNavLabel: {
    color: theme.text,
    fontSize: 12
  },
  mobileNavLabelActive: {
    color: theme.accent,
    fontWeight: "700"
  },
  mobileMenuSheet: {
    backgroundColor: "rgba(24,18,14,0.98)",
    borderColor: theme.line,
    borderRadius: 18,
    borderWidth: 1,
    left: 12,
    padding: 10,
    position: "absolute",
    right: 12,
    zIndex: 5
  },
  mobileMenuRow: {
    alignItems: "center",
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12
  },
  mobileMenuLabel: {
    color: theme.text,
    fontWeight: "400"
  },
  detailPrimaryActionButton: {
    justifyContent: "center",
    minWidth: 132
  },
  detailSecondaryActionButton: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minWidth: 124
  }
});
