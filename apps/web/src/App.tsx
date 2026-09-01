import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Fragment } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowLeft,
  BookmarkCheck,
  CircleCheck,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  EllipsisVertical,
  FileHeadphone,
  FilePenLine,
  Heart,
  Home,
  HatGlasses,
  KeyRound,
  Library,
  Logs,
  ListEnd,
  ListFilter,
  ListMusic,
  ListStart,
  ListVideo,
  Loader2,
  Menu,
  Music,
  Pause,
  Play,
  Radio,
  RedoDot,
  RotateCcw,
  Repeat,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  UndoDot,
  UserRoundPlus,
  Volume2,
  X,
  type LucideIcon
} from "lucide-react";
import type {
  AlbumDetailRecord,
  AlbumRecord,
  AppBootstrap,
  AppSettings,
  ArtistRecord,
  BookDetailRecord,
  BookProgressRecord,
  BookRecord,
  LibrarySummary,
  PlaylistRecord,
  ScanError,
  TrackRecord,
  UserApiKeyStatus
} from "@mp3-platform/shared";
import {
  addTrackToPlaylist,
  createPlaylist,
  deleteUserApiKey,
  fetchUserApiKeyStatus,
  fetchAlbumDetail,
  fetchAlbums,
  fetchArtists,
  fetchBootstrap,
  fetchBookDetail,
  fetchBooks,
  fetchAppJobs,
  fetchLikedTrackIds,
  fetchLibrarySummary,
  fetchPlaylists,
  fetchRecentlyPlayed,
  fetchTracks,
  identifyAlbum,
  generateUserApiKey,
  getCoverArtUrl,
  getStreamUrl,
  likeTrack,
  loginUser,
  recordTrackPlay,
  registerFirstUser,
  requestFolderRescan,
  runMobileCoverArtJobNow,
  saveBookProgress,
  storeSessionToken,
  type AlbumIdentifyCandidate,
  type AlbumIdentifyFilters,
  type AlbumTagsPayload,
  type TrackTagsPayload,
  type UserPlaylist,
  unlikeTrack,
  updateAlbumMediaKind,
  updateAlbumTags,
  updateSettings
  ,
  updateTrackTags
} from "./lib/api.js";
import groovyBrandIcon from "./assets/groovy-brand-icon.png";

type ViewName = "home" | "search" | "library" | "albums" | "album" | "artists" | "artist" | "authors" | "author" | "books" | "book" | "playlists" | "playlist" | "liked" | "recent" | "recentlyAdded" | "queue" | "settings";
type AuthMode = "register" | "login";
type LibraryBrowseMode = "all" | "albums" | "artists" | "authors" | "books";
type RouteState = {
  view: ViewName;
  selectedAlbumId: string | null;
  selectedArtistId: string | null;
  selectedAuthorId: string | null;
  selectedPlaylistId: string | null;
  selectedBookId: string | null;
  showSettings: boolean;
  showMobileMenu: boolean;
};

type LibraryData = {
  summary: LibrarySummary;
  tracks: TrackRecord[];
  artists: ArtistRecord[];
  albums: AlbumRecord[];
  books: BookRecord[];
  playlists: PlaylistRecord[];
};

type AlbumWithTracks = AlbumRecord & {
  tracks: TrackRecord[];
  yearLabel: string;
};

type ArtistWithTracks = ArtistRecord & {
  tracks: TrackRecord[];
  albums: AlbumWithTracks[];
  durationSeconds: number;
};

type BookWithTracks = BookRecord & {
  tracks: TrackRecord[];
};

type AuthorWithBooks = {
  id: string;
  name: string;
  books: BookWithTracks[];
  tracks: TrackRecord[];
  durationSeconds: number;
};

type PlaylistDetailRecord = {
  id: string;
  name: string;
  description: string;
  tracks: TrackRecord[];
  coverArtId: string | null;
  accent: "cool" | "warm" | "sunset";
  kind: "personal" | "smart";
  metaLabel: string;
};

type DebugLogEntry = {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
};

type AlbumIdentifyState = {
  albumId: string;
  albumName: string;
  candidates: AlbumIdentifyCandidate[];
  filters: AlbumIdentifyFilters;
};

type LibraryBooksSortOption = "default" | "length" | "genre" | "status" | "author" | "date-added" | "year";
type LibraryAuthorsSortOption = "author" | "book-count";

type AlbumTagsEditorState = {
  albumId: string;
  albumName: string;
  values: AlbumTagsPayload;
};

type TrackTagsEditorState = {
  trackId: string;
  contextLabel: string;
  values: TrackTagsPayload;
};

const emptyIdentifyFilters = (): AlbumIdentifyFilters => ({
  artist: "",
  albumArtist: "",
  year: "",
  genre: ""
});

const buildIdentifyFilters = (albumArtist: string | null, albumTracks: TrackRecord[], albumYear?: number | null, albumGenre?: string | null) => ({
  artist: albumTracks.find((track) => track.artist)?.artist ?? albumArtist ?? "",
  albumArtist: albumTracks.find((track) => track.albumArtist)?.albumArtist ?? albumArtist ?? "",
  year: String(albumYear ?? albumTracks.find((track) => track.year)?.year ?? ""),
  genre: albumGenre ?? albumTracks.find((track) => track.genre)?.genre ?? ""
});

const parseIdentifyYear = (value: string) => {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
};

const PLAYER_VOLUME_KEY = "mp3-platform-player-volume";

const DEFAULT_APP_SETTINGS: AppSettings = {
  libraryRoots: [],
  bookRoots: [],
  scanIntervalMinutes: 15,
  queueAlbumTracksOnPlay: true,
  promptBeforeReplacingQueueOnPlay: true,
  showEntityMetadataOnHeroImage: false,
  mobileOptimizedCoversEnabled: true,
  mobileOptimizedCoverJobTime: "03:00"
};

const normalizeAppSettings = (settings: Partial<AppSettings> | null | undefined): AppSettings => ({
  libraryRoots: settings?.libraryRoots ?? [],
  bookRoots: settings?.bookRoots ?? [],
  scanIntervalMinutes: settings?.scanIntervalMinutes ?? DEFAULT_APP_SETTINGS.scanIntervalMinutes,
  queueAlbumTracksOnPlay: settings?.queueAlbumTracksOnPlay ?? DEFAULT_APP_SETTINGS.queueAlbumTracksOnPlay,
  promptBeforeReplacingQueueOnPlay: settings?.promptBeforeReplacingQueueOnPlay ?? DEFAULT_APP_SETTINGS.promptBeforeReplacingQueueOnPlay,
  showEntityMetadataOnHeroImage: settings?.showEntityMetadataOnHeroImage ?? DEFAULT_APP_SETTINGS.showEntityMetadataOnHeroImage,
  mobileOptimizedCoversEnabled: settings?.mobileOptimizedCoversEnabled ?? DEFAULT_APP_SETTINGS.mobileOptimizedCoversEnabled,
  mobileOptimizedCoverJobTime: settings?.mobileOptimizedCoverJobTime ?? DEFAULT_APP_SETTINGS.mobileOptimizedCoverJobTime
});

const navItems: Array<{ id: ViewName; label: string; icon: LucideIcon }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "albums", label: "Discover", icon: Search },
  { id: "artists", label: "Radio", icon: Radio },
  { id: "library", label: "Library", icon: Library }
];

const mobileNavItems: Array<{ label: string; icon: LucideIcon; id?: ViewName; action: "view" | "menu" }> = [
  { id: "home", label: "Home", icon: Home, action: "view" },
  { id: "library", label: "Library", icon: Library, action: "view" },
  { id: "search", label: "Search", icon: Search, action: "view" },
  { label: "Menu", icon: Menu, action: "menu" }
];

const allowedViews: ViewName[] = ["home", "search", "library", "albums", "album", "artists", "artist", "authors", "author", "books", "book", "playlists", "playlist", "liked", "recent", "recentlyAdded", "queue", "settings"];

const sanitizeRouteState = (route: RouteState): RouteState => {
  const nextRoute = {
    ...route
  };

  if (nextRoute.view !== "album") {
    nextRoute.selectedAlbumId = null;
  }

  if (nextRoute.view !== "artist") {
    nextRoute.selectedArtistId = null;
  }

  if (nextRoute.view !== "author") {
    nextRoute.selectedAuthorId = null;
  }

  if (nextRoute.view !== "playlist") {
    nextRoute.selectedPlaylistId = null;
  }

  if (nextRoute.view !== "book") {
    nextRoute.selectedBookId = null;
  }

  if (nextRoute.view === "album" && !nextRoute.selectedAlbumId) {
    nextRoute.view = "albums";
  }

  if (nextRoute.view === "artist" && !nextRoute.selectedArtistId) {
    nextRoute.view = "artists";
  }

  if (nextRoute.view === "author" && !nextRoute.selectedAuthorId) {
    nextRoute.view = "authors";
  }

  if (nextRoute.view === "playlist" && !nextRoute.selectedPlaylistId) {
    nextRoute.view = "playlists";
  }

  if (nextRoute.view === "book" && !nextRoute.selectedBookId) {
    nextRoute.view = "books";
  }

  return nextRoute;
};

const parseRouteState = (): RouteState => {
  const params = new URLSearchParams(window.location.search);
  const segments = window.location.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const legacyView = params.get("view");
  const route: RouteState = {
    view: allowedViews.includes(legacyView as ViewName) ? (legacyView as ViewName) : "home",
    selectedAlbumId: null,
    selectedArtistId: null,
    selectedAuthorId: null,
    selectedPlaylistId: null,
    selectedBookId: null,
    showSettings: false,
    showMobileMenu: params.get("mobileMenu") === "1"
  };

  if (segments.length === 0) {
    return sanitizeRouteState(route);
  }

  const [section, identifier] = segments;

  switch (section) {
    case "search":
      route.view = "search";
      break;
    case "library":
      route.view = identifier === "recently-added" ? "recentlyAdded" : "library";
      break;
    case "albums":
      route.view = identifier ? "album" : "albums";
      route.selectedAlbumId = identifier ? decodeURIComponent(identifier) : null;
      break;
    case "artists":
      route.view = identifier ? "artist" : "artists";
      route.selectedArtistId = identifier ? decodeURIComponent(identifier) : null;
      break;
    case "authors":
      route.view = identifier ? "author" : "authors";
      route.selectedAuthorId = identifier ? decodeURIComponent(identifier) : null;
      break;
    case "books":
      route.view = identifier ? "book" : "books";
      route.selectedBookId = identifier ? decodeURIComponent(identifier) : null;
      break;
    case "playlists":
      route.view = identifier ? "playlist" : "playlists";
      route.selectedPlaylistId = identifier ? decodeURIComponent(identifier) : null;
      break;
    case "liked":
      route.view = "liked";
      break;
    case "recent":
      route.view = "recent";
      break;
    case "queue":
      route.view = "queue";
      break;
    case "settings":
      route.view = "settings";
      break;
    default:
      route.view = "home";
      break;
  }

  if (params.get("settings") === "library") {
    route.view = "settings";
  }

  return sanitizeRouteState(route);
};

const buildRoutePath = (route: RouteState) => {
  switch (route.view) {
    case "home":
      return "/";
    case "search":
      return "/search";
    case "library":
      return "/library";
    case "recentlyAdded":
      return "/library/recently-added";
    case "albums":
      return "/albums";
    case "album":
      return route.selectedAlbumId ? `/albums/${encodeURIComponent(route.selectedAlbumId)}` : "/albums";
    case "artists":
      return "/artists";
    case "artist":
      return route.selectedArtistId ? `/artists/${encodeURIComponent(route.selectedArtistId)}` : "/artists";
    case "authors":
      return "/authors";
    case "author":
      return route.selectedAuthorId ? `/authors/${encodeURIComponent(route.selectedAuthorId)}` : "/authors";
    case "books":
      return "/books";
    case "book":
      return route.selectedBookId ? `/books/${encodeURIComponent(route.selectedBookId)}` : "/books";
    case "playlists":
      return "/playlists";
    case "playlist":
      return route.selectedPlaylistId ? `/playlists/${encodeURIComponent(route.selectedPlaylistId)}` : "/playlists";
    case "liked":
      return "/liked";
    case "recent":
      return "/recent";
    case "queue":
      return "/queue";
    case "settings":
      return "/settings";
    default:
      return "/";
  }
};

const buildRouteUrl = (route: RouteState) => {
  const params = new URLSearchParams();

  if (route.showMobileMenu) {
    params.set("mobileMenu", "1");
  }

  const query = params.toString();
  return `${buildRoutePath(route)}${query ? `?${query}` : ""}`;
};

const hydratePreviewSessionToken = () => {
  const params = new URLSearchParams(window.location.search);
  const sessionToken = params.get("sessionToken");

  if (!sessionToken) {
    return;
  }

  storeSessionToken(sessionToken);
  params.delete("sessionToken");
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", nextUrl);
};

const sortTracksByPlaybackOrder = (tracks: TrackRecord[]) =>
  [...tracks].sort((left, right) => {
    const discDifference = (left.discNumber ?? 0) - (right.discNumber ?? 0);

    if (discDifference !== 0) {
      return discDifference;
    }

    const trackDifference = (left.trackNumber ?? 0) - (right.trackNumber ?? 0);

    if (trackDifference !== 0) {
      return trackDifference;
    }

    return (left.title ?? left.filePath).localeCompare(right.title ?? right.filePath);
  });

const shuffleTracks = (tracks: TrackRecord[]) => {
  const nextTracks = [...tracks];

  for (let index = nextTracks.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextTracks[index], nextTracks[swapIndex]] = [nextTracks[swapIndex] as TrackRecord, nextTracks[index] as TrackRecord];
  }

  return nextTracks;
};

const pickStablePlaylistCoverArt = (playlistId: string, tracks: TrackRecord[]) => {
  if (tracks.length === 0) {
    return null;
  }

  const coverArtTracks = tracks.filter((track) => track.coverArtId);
  const sourceTracks = coverArtTracks.length > 0 ? coverArtTracks : tracks;
  const seed = [...playlistId].reduce((total, character) => total + character.charCodeAt(0), 0);
  return sourceTracks[seed % sourceTracks.length]?.coverArtId ?? null;
};

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const formatTrackTime = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "--:--";
  }

  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
};

const toTitleCaseGenre = (value: string) =>
  value
    .split(/([\s/-]+)/)
    .map((part) => (/[\s/-]+/.test(part) || !part
      ? part
      : `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`))
    .join("");

const normalizeGenreLabel = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }

  const collapsed = value.replace(/\s+/g, " ").trim();

  if (!collapsed) {
    return null;
  }

  const lowerCased = collapsed.toLocaleLowerCase();
  return toTitleCaseGenre(lowerCased);
};

const normalizeGenreLabels = (values: Array<string | null | undefined>) => {
  const deduped = new Map<string, string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    for (const part of value.split(",")) {
      const normalized = normalizeGenreLabel(part);

      if (!normalized) {
        continue;
      }

      const key = normalized.toLocaleLowerCase();

      if (!deduped.has(key)) {
        deduped.set(key, normalized);
      }
    }
  }

  return [...deduped.values()];
};

const copyTextToClipboard = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back for non-secure origins and browsers that reject the async clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
};

const truncateLabel = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : value);

const formatBookPositionLabel = (track: TrackRecord | null | undefined, positionSeconds: number | null | undefined) => {
  if (!track || positionSeconds === null || positionSeconds === undefined) {
    return null;
  }

  return `${track.title ?? "Current chapter"} at ${formatTrackTime(positionSeconds)}`;
};

const hasMeaningfulBookProgress = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!progress || !Array.isArray(tracks) || tracks.length === 0) {
    return false;
  }

  const orderedTracks = sortTracksByPlaybackOrder(tracks);
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

const getBookAbsolutePositionSeconds = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!progress || !Array.isArray(tracks) || tracks.length === 0) {
    return null;
  }

  const orderedTracks = sortTracksByPlaybackOrder(tracks);
  const currentTrackIndex = orderedTracks.findIndex((track) => track.id === progress.trackId);

  if (currentTrackIndex < 0) {
    return null;
  }

  const secondsBeforeCurrentTrack = orderedTracks
    .slice(0, currentTrackIndex)
    .reduce((total, track) => total + Math.max(0, track.durationSeconds ?? 0), 0);

  return secondsBeforeCurrentTrack + Math.max(0, progress.positionSeconds);
};

const isBookCompleted = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  const totalDurationSeconds = getBookDurationSeconds(tracks);
  const absolutePositionSeconds = getBookAbsolutePositionSeconds(progress, tracks);

  if (totalDurationSeconds <= 0 || absolutePositionSeconds === null) {
    return false;
  }

  return absolutePositionSeconds >= Math.max(0, totalDurationSeconds - 600);
};

const isBookInProgress = (
  progress: { trackId: string; positionSeconds: number } | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  const absolutePositionSeconds = getBookAbsolutePositionSeconds(progress, tracks);
  return absolutePositionSeconds !== null && absolutePositionSeconds > 300 && !isBookCompleted(progress, tracks);
};

const getLatestMeaningfulBookmark = (
  bookmarks: BookDetailRecord["bookmarks"] | null | undefined,
  tracks: TrackRecord[] | null | undefined
) => {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return null;
  }

  const meaningfulBookmarks = bookmarks.filter((bookmark) => hasMeaningfulBookProgress(bookmark, tracks));

  if (meaningfulBookmarks.length === 0) {
    return null;
  }

  return [...meaningfulBookmarks].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
};

const getTrackDisplayArtist = (track: TrackRecord) =>
  track.bookId ? track.artist ?? track.author ?? "Unknown artist" : track.author ?? track.artist ?? "Unknown artist";

const getBookCardGenre = (book: BookWithTracks) => {
  const genres = normalizeGenreLabels(book.tracks.map((track) => track.genre));

  return genres[0] ?? "";
};

const getBookCardYear = (book: BookWithTracks) =>
  book.tracks.reduce<number | null>((latestYear, track) => {
    if (!track.year) {
      return latestYear;
    }

    if (latestYear === null) {
      return track.year;
    }

    return Math.max(latestYear, track.year);
  }, null);

const getBookCardDateAdded = (book: BookWithTracks) =>
  [...book.tracks]
    .map((track) => track.modifiedAt)
    .sort((left, right) => right.localeCompare(left))[0] ?? "";

const getBookCardStatus = (book: BookWithTracks) => {
  const progress = getBookCardProgress(book);

  if (isBookCompleted(progress, book.tracks)) {
    return "completed" as const;
  }

  if (isBookInProgress(progress, book.tracks)) {
    return "in-progress" as const;
  }

  return "not-started" as const;
};

const isBookCardCached = (_book: BookWithTracks) => false;

type HeroMenuEntry = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect?: (() => void) | null;
  disabled?: boolean;
  destructive?: boolean;
};

const EntityHeroMenu = ({ entityLabel, entries }: { entityLabel: string; entries: HeroMenuEntry[] }) => {
  const [menuOpen, setMenuOpen] = useState(false);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="entity-hero-menu">
      {menuOpen ? <button type="button" className="entity-hero-menu-backdrop" onClick={() => setMenuOpen(false)} aria-label={`Close ${entityLabel} menu`} /> : null}
      <button
        type="button"
        className="footer-icon-button album-action-icon entity-hero-menu-trigger"
        onClick={() => setMenuOpen((previous) => !previous)}
        aria-label={`${entityLabel} menu`}
        title={`${entityLabel} menu`}
      >
        <EllipsisVertical className="h-5 w-5" />
      </button>
      {menuOpen ? (
        <div className="entity-hero-menu-panel">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={entry.destructive ? "entity-hero-menu-item destructive" : "entity-hero-menu-item"}
              disabled={entry.disabled}
              onClick={() => {
                setMenuOpen(false);
                entry.onSelect?.();
              }}
            >
              <span className="entity-hero-menu-item-icon">{entry.icon}</span>
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const EntityHeroImageOverlay = ({
  eyebrow,
  title,
  meta
}: {
  eyebrow: string;
  title: string;
  meta: Array<string | null | undefined>;
}) => (
  <div className="entity-hero-image-overlay">
    <div className="entity-hero-image-shade" aria-hidden="true" />
    <div className="entity-hero-image-copy">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p className="album-detail-meta">{renderDetailMeta(meta)}</p>
    </div>
  </div>
);

const EntityListImageOverlay = ({
  title,
  primaryLine,
  secondaryLine,
  tertiaryLine
}: {
  title: string;
  primaryLine?: string | null;
  secondaryLine?: string | null;
  tertiaryLine?: string | null;
}) => (
  <div className="entity-list-image-overlay">
    <div className="entity-list-image-shade" aria-hidden="true" />
    <div className="entity-list-image-copy">
      <h3>{title}</h3>
      {primaryLine ? <p className="entity-list-image-primary">{primaryLine}</p> : null}
      {secondaryLine ? <p className="entity-list-image-secondary">{secondaryLine}</p> : null}
      {tertiaryLine ? <p className="entity-list-image-secondary">{tertiaryLine}</p> : null}
    </div>
  </div>
);

const renderDetailMeta = (items: Array<string | null | undefined>) =>
  items
    .filter((item): item is string => Boolean(item?.trim()))
    .flatMap((item, index) => [
      index > 0 ? <span key={`separator-${index}`} className="meta-separator" aria-hidden="true">{"\u00B7"}</span> : null,
      <span key={`item-${index}`} className={index === 0 ? "detail-meta-primary" : undefined}>{item}</span>
    ]);

const buildAlbumGroups = (albums: AlbumRecord[], tracks: TrackRecord[]) => {
  const tracksByAlbumId = new Map<string, TrackRecord[]>();

  for (const track of tracks) {
    const existing = tracksByAlbumId.get(track.albumId) ?? [];
    existing.push(track);
    tracksByAlbumId.set(track.albumId, existing);
  }

  return albums.map<AlbumWithTracks>((album) => {
    const albumTracks = sortTracksByPlaybackOrder(tracksByAlbumId.get(album.id) ?? []);
    const newestTrack = albumTracks.reduce<TrackRecord | null>(
      (currentNewest, track) => !currentNewest || track.modifiedAt > currentNewest.modifiedAt ? track : currentNewest,
      null
    );

    return {
      ...album,
      tracks: albumTracks,
      yearLabel: newestTrack ? new Date(newestTrack.modifiedAt).getFullYear().toString() : "----"
    };
  });
};

const getTrackArtistGroupId = (track: TrackRecord) => track.albumArtistId || track.artistId;

const buildArtistGroups = (artists: ArtistRecord[], albumGroups: AlbumWithTracks[]) => {
  const tracksByArtistId = new Map<string, TrackRecord[]>();
  const albumsByArtistId = new Map<string, AlbumWithTracks[]>();

  for (const album of albumGroups) {
    const albumArtistIds = new Set(album.tracks.map((track) => getTrackArtistGroupId(track)).filter(Boolean));

    for (const track of album.tracks) {
      const artistId = getTrackArtistGroupId(track);
      const existingTracks = tracksByArtistId.get(artistId) ?? [];
      existingTracks.push(track);
      tracksByArtistId.set(artistId, existingTracks);
    }

    for (const artistId of albumArtistIds) {
      const existingAlbums = albumsByArtistId.get(artistId) ?? [];
      existingAlbums.push(album);
      albumsByArtistId.set(artistId, existingAlbums);
    }
  }

  return artists.map<ArtistWithTracks>((artist) => {
    const artistTracks = tracksByArtistId.get(artist.id) ?? [];
    const artistAlbums = albumsByArtistId.get(artist.id) ?? [];

    return {
      ...artist,
      tracks: artistTracks,
      albums: artistAlbums,
      durationSeconds: artistTracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0)
    };
  });
};

const getArtistListCoverArtId = (artist: ArtistWithTracks) =>
  artist.albums.find((album) => album.coverArtId)?.coverArtId ?? artist.tracks.find((track) => track.coverArtId)?.coverArtId ?? null;

const getBookCardProgress = (book: BookWithTracks) =>
  book.lastTrackId
    ? {
        trackId: book.lastTrackId,
        positionSeconds: book.lastPositionSeconds ?? 0
      }
    : null;

const getBookCardResumeLabel = (book: BookWithTracks) => {
  const resumeTrack = book.tracks.find((track) => track.id === book.lastTrackId) ?? null;
  return formatBookPositionLabel(resumeTrack, book.lastPositionSeconds);
};

const getBookDisplayAuthor = (book: Pick<BookRecord, "author">, tracks: TrackRecord[]) =>
  tracks.find((track) => track.bookId && track.artist)?.artist ?? tracks.find((track) => track.artist)?.artist ?? book.author;

const buildBookGroups = (books: BookRecord[], tracks: TrackRecord[]) => {
  const tracksByBookId = new Map<string, TrackRecord[]>();

  for (const track of tracks) {
    if (!track.bookId) {
      continue;
    }

    const existing = tracksByBookId.get(track.bookId) ?? [];
    existing.push(track);
    tracksByBookId.set(track.bookId, existing);
  }

  return books.map<BookWithTracks>((book) => {
    const bookTracks = sortTracksByPlaybackOrder(tracksByBookId.get(book.id) ?? []);

    return {
      ...book,
      author: getBookDisplayAuthor(book, bookTracks),
      tracks: bookTracks
    };
  });
};

const createAuthorId = (name: string) => `author:${name.trim().toLowerCase()}`;

const buildAuthorGroups = (books: BookWithTracks[]) => {
  const byAuthor = new Map<string, BookWithTracks[]>();

  for (const book of books) {
    const authorName = book.author.trim() || "Unknown Author";
    const existing = byAuthor.get(authorName) ?? [];
    existing.push(book);
    byAuthor.set(authorName, existing);
  }

  return [...byAuthor.entries()].map<AuthorWithBooks>(([name, authorBooks]) => {
    const tracks = authorBooks.flatMap((book) => book.tracks);

    return {
      id: createAuthorId(name),
      name,
      books: [...authorBooks].sort((left, right) => left.title.localeCompare(right.title)),
      tracks: sortTracksByPlaybackOrder(tracks),
      durationSeconds: tracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0)
    };
  });
};

const getAuthorListCoverArtId = (author: AuthorWithBooks, scanSeed: string | null) => {
  const coverArtBooks = author.books.filter((book) => book.coverArtId);
  const sourceBooks = coverArtBooks.length > 0 ? coverArtBooks : author.books;

  if (sourceBooks.length === 0) {
    return author.tracks.find((track) => track.coverArtId)?.coverArtId ?? null;
  }

  const seedSource = `${author.id}::${scanSeed ?? "no-scan-seed"}`;
  const seed = [...seedSource].reduce((total, character) => total + character.charCodeAt(0), 0);
  return sourceBooks[seed % sourceBooks.length]?.coverArtId ?? null;
};

const buildPlaylists = (tracks: TrackRecord[], albums: AlbumWithTracks[], artists: ArtistWithTracks[]): PlaylistRecord[] => {
  const recentlyAdded = [...tracks].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, 25);
  const eveningAlbums = albums.slice(0, 3).flatMap((album) => album.tracks).slice(0, 20);
  const artistSpotlight = artists.slice(0, 3).flatMap((artist) => artist.tracks).slice(0, 24);
  const longPlay = [...tracks].sort((left, right) => (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0)).slice(0, 20);
  const createdAt = "smart-playlist";

  return [
    {
      id: "playlist:recently-added",
      name: "Recently Added",
      createdAt,
      trackCount: recentlyAdded.length,
      durationSeconds: recentlyAdded.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      description: "Freshly indexed tracks from your library.",
      tracks: recentlyAdded,
      coverArtId: recentlyAdded[0]?.coverArtId ?? null,
      accent: "cool" as const,
      isSmart: true
    },
    {
      id: "playlist:after-hours",
      name: "After Hours Queue",
      createdAt,
      trackCount: eveningAlbums.length,
      durationSeconds: eveningAlbums.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      description: "A mellow run built from the albums at the front of your collection.",
      tracks: eveningAlbums,
      coverArtId: eveningAlbums[0]?.coverArtId ?? null,
      accent: "sunset" as const,
      isSmart: true
    },
    {
      id: "playlist:artist-spotlight",
      name: "Artist Spotlight",
      createdAt,
      trackCount: artistSpotlight.length,
      durationSeconds: artistSpotlight.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      description: "A rotating set from the most visible artists in your index.",
      tracks: artistSpotlight,
      coverArtId: artistSpotlight[0]?.coverArtId ?? null,
      accent: "warm" as const,
      isSmart: true
    },
    {
      id: "playlist:long-play",
      name: "Long Play",
      createdAt,
      trackCount: longPlay.length,
      durationSeconds: longPlay.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      description: "Longer tracks for uninterrupted listening.",
      tracks: longPlay,
      coverArtId: longPlay[0]?.coverArtId ?? null,
      accent: "cool" as const,
      isSmart: true
    }
  ].filter((playlist) => playlist.tracks.length > 0);
};

const isTrackHeavyView = (view: ViewName) => ["search", "artist", "author", "liked", "recent", "recentlyAdded", "playlists", "playlist", "queue"].includes(view);

const IncrementalGrid = <T,>({
  items,
  className,
  batchSize,
  initialBatchSize,
  itemKey,
  renderItem
}: {
  items: T[];
  className: string;
  batchSize: number;
  initialBatchSize?: number;
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
}) => {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const resolvedInitialBatchSize = initialBatchSize ?? batchSize;
  const [visibleCount, setVisibleCount] = useState(() => Math.min(items.length, resolvedInitialBatchSize));

  useEffect(() => {
    setVisibleCount(Math.min(items.length, resolvedInitialBatchSize));
  }, [items, resolvedInitialBatchSize]);

  useEffect(() => {
    if (visibleCount >= items.length) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setVisibleCount(items.length);
      return;
    }

    const node = sentinelRef.current;

    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((previous) => Math.min(items.length, previous + batchSize));
        }
      },
      {
        rootMargin: "480px 0px"
      }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [batchSize, items.length, visibleCount]);

  return (
    <div className={className}>
      {items.slice(0, visibleCount).map((item, index) => (
        <Fragment key={itemKey(item, index)}>{renderItem(item, index)}</Fragment>
      ))}
      {visibleCount < items.length ? <div ref={sentinelRef} className="incremental-grid-sentinel" aria-hidden="true" /> : null}
    </div>
  );
};

const CoverArtImage = ({ src, alt }: { src: string | null; alt: string }) => {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(src ? "loading" : "error");

  useEffect(() => {
    setStatus(src ? "loading" : "error");
  }, [src]);

  if (!src) {
    return (
      <div className="art-frame is-error" aria-label={alt}>
        <div className="art-placeholder" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={status === "loaded" ? "art-frame is-loaded" : status === "error" ? "art-frame is-error" : "art-frame"}>
      <div className="art-placeholder" aria-hidden="true" />
      <img
        className="art-image"
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
      />
    </div>
  );
};

const AlbumArt = ({ coverArtId, alt, cacheBuster }: { coverArtId: string | null; alt: string; cacheBuster?: string | number }) => {
  const src = getCoverArtUrl(coverArtId, cacheBuster);
  return <CoverArtImage src={src} alt={alt} />;
};

const ArtistArt = ({ artist, coverArtId, cacheBuster }: { artist: string; coverArtId: string | null; cacheBuster?: string | number }) => {
  const src = getCoverArtUrl(coverArtId, cacheBuster);

  if (src) {
    return <CoverArtImage src={src} alt={artist} />;
  }

  return (
    <div className="artist-detail-fallback" aria-label={artist}>
      <div className="artist-avatar large artist-detail-avatar">{artist.charAt(0)}</div>
      <span>{artist}</span>
    </div>
  );
};

const LibraryCardSkeleton = ({
  className,
  showMetaLines = 2
}: {
  className: string;
  showMetaLines?: number;
}) => (
  <div className={className} aria-hidden="true">
    <div className="art-frame is-error">
      <div className="art-placeholder" />
    </div>
    <div className="entity-card-skeleton-copy">
      <span className="entity-card-skeleton-line title" />
      {Array.from({ length: showMetaLines }).map((_, index) => (
        <span
          key={index}
          className={index === showMetaLines - 1 ? "entity-card-skeleton-line short" : "entity-card-skeleton-line"}
        />
      ))}
    </div>
  </div>
);

const GridSkeleton = ({
  className,
  cardClassName,
  count,
  metaLines = 2
}: {
  className: string;
  cardClassName: string;
  count: number;
  metaLines?: number;
}) => (
  <div className={`${className} entity-grid-skeleton`} aria-hidden="true">
    {Array.from({ length: count }).map((_, index) => (
      <LibraryCardSkeleton key={index} className={cardClassName} showMetaLines={metaLines} />
    ))}
  </div>
);

const NowPlayingGlyph = ({ animated = false }: { animated?: boolean }) => (
  <svg className={animated ? "now-playing-glyph is-animated" : "now-playing-glyph"} viewBox="0 0 20 20" aria-hidden="true">
    <rect className="now-playing-bar bar-1" x="4" y="8" width="2" height="8" rx="1" />
    <rect className="now-playing-bar bar-2" x="9" y="4" width="2" height="12" rx="1" />
    <rect className="now-playing-bar bar-3" x="14" y="6" width="2" height="10" rx="1" />
  </svg>
);

const AlbumIdentifyDialog = ({
  albumName,
  filters,
  candidates,
  busy,
  pendingCandidateId,
  onClose,
  onSelect,
  onSearch,
  onChangeFilters
}: {
  albumName: string;
  filters: AlbumIdentifyFilters;
  candidates: AlbumIdentifyCandidate[];
  busy: boolean;
  pendingCandidateId: number | null;
  onClose: () => void;
  onSelect: (candidateId: number) => Promise<void>;
  onSearch: () => Promise<void>;
  onChangeFilters: (patch: Partial<AlbumIdentifyFilters>) => void;
}) => (
  <div className="modal-scrim">
    <div className="auth-card identify-dialog">
      <div className="dialog-header">
        <div className="modal-copy">
          <p className="eyebrow">Discogs identify</p>
          <h2>{albumName}</h2>
          <p>Select the best Discogs release match before we write the local cover art and NFO.</p>
        </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close identify dialog">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="identify-filter-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void onSearch();
        }}
      >
        <div className="identify-filter-grid">
          <label className="field">
            <span>Artist tag</span>
            <input value={filters.artist} onChange={(event) => onChangeFilters({ artist: event.target.value })} placeholder="Band or artist name" />
          </label>
          <label className="field">
            <span>Album Artist tag</span>
            <input
              value={filters.albumArtist}
              onChange={(event) => onChangeFilters({ albumArtist: event.target.value })}
              placeholder="Album artist tag"
            />
          </label>
          <label className="field">
            <span>Year tag</span>
            <input value={filters.year} onChange={(event) => onChangeFilters({ year: event.target.value })} inputMode="numeric" placeholder="2004" />
          </label>
          <label className="field">
            <span>Genre tag</span>
            <input value={filters.genre} onChange={(event) => onChangeFilters({ genre: event.target.value })} placeholder="Indie, Rock..." />
          </label>
        </div>

        <div className="identify-filter-actions">
          <button type="submit" className="cta-button" disabled={busy}>
            {busy ? "Searching..." : "Search Discogs"}
          </button>
          <button type="button" className="pill-button ghost" onClick={() => onChangeFilters(emptyIdentifyFilters())} disabled={busy}>
            Reset filters
          </button>
        </div>
      </form>

      <div className="identify-results">
        {candidates.length === 0 ? <p className="identify-empty-state">No matching Discogs releases found for the current filters.</p> : null}
        {candidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={pendingCandidateId === candidate.id ? "identify-result is-loading" : "identify-result"}
            onClick={() => void onSelect(candidate.id)}
            disabled={busy}
          >
            <div className="identify-result-art">
              {candidate.thumbUrl ? <img src={candidate.thumbUrl} alt="" loading="lazy" /> : <div className="art-placeholder" />}
            </div>
            <div className="identify-result-copy">
              <strong className="identify-result-title">
                {pendingCandidateId === candidate.id && busy ? <Loader2 className="h-4 w-4 identify-spinner" /> : null}
                <span>{candidate.title ?? "Unknown release"}</span>
              </strong>
              <span>{candidate.artist ?? "Unknown artist"}</span>
              <span>{[candidate.year ?? "----", candidate.country, candidate.format].filter(Boolean).join(" / ")}</span>
              <span>{[candidate.label].filter(Boolean).join(" / ") || "No label info"}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="identify-footer">
        {busy ? <span className="identify-status">Writing local art and metadata...</span> : null}
        <button type="button" className="pill-button ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  </div>
);

const AlbumBioDialog = ({
  albumName,
  albumArtist,
  text,
  onClose
}: {
  albumName: string;
  albumArtist: string;
  text: string;
  onClose: () => void;
}) => (
  <div className="modal-scrim">
    <div className="auth-card identify-dialog album-bio-dialog">
      <div className="dialog-header">
        <div className="modal-copy">
          <p className="eyebrow">Album bio</p>
          <h2>{albumName}</h2>
          <p>{albumArtist}</p>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close album bio">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="album-bio-dialog-body">{text}</div>
    </div>
  </div>
);

const AlbumTagsDialog = ({
  albumName,
  values,
  busy,
  error,
  onChange,
  onClose,
  onSave
}: {
  albumName: string;
  values: AlbumTagsPayload;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<AlbumTagsPayload>) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}) => (
  <div className="modal-scrim">
    <div className="auth-card identify-dialog tag-editor-dialog">
      <div className="dialog-header">
        <div className="modal-copy">
          <p className="eyebrow">Edit ID3 Tags</p>
          <h2>{albumName}</h2>
          <p>Update the album-wide tags across every track in this album.</p>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close album tag editor">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="tag-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <div className="tag-editor-grid">
          <label className="field">
            <span>Artist</span>
            <input value={values.artist} onChange={(event) => onChange({ artist: event.target.value })} />
          </label>
          <label className="field">
            <span>Album Artist</span>
            <input value={values.albumArtist} onChange={(event) => onChange({ albumArtist: event.target.value })} />
          </label>
          <label className="field">
            <span>Album</span>
            <input value={values.album} onChange={(event) => onChange({ album: event.target.value })} />
          </label>
          <label className="field">
            <span>Year</span>
            <input value={values.year} onChange={(event) => onChange({ year: event.target.value })} inputMode="numeric" />
          </label>
          <label className="field tag-editor-grid-span">
            <span>Genre</span>
            <input value={values.genre} onChange={(event) => onChange({ genre: event.target.value })} />
          </label>
        </div>

        {error ? <p className="error-banner inline">{error}</p> : null}

        <div className="identify-footer">
          <button type="button" className="pill-button ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="cta-button" disabled={busy}>
            {busy ? "Saving..." : "Save Tags"}
          </button>
        </div>
      </form>
    </div>
  </div>
);

const TrackTagsDialog = ({
  contextLabel,
  values,
  busy,
  error,
  onChange,
  onClose,
  onSave
}: {
  contextLabel: string;
  values: TrackTagsPayload;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<TrackTagsPayload>) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}) => (
  <div className="modal-scrim">
    <div className="auth-card identify-dialog tag-editor-dialog">
      <div className="dialog-header">
        <div className="modal-copy">
          <p className="eyebrow">Edit ID3 Tags</p>
          <h2>{contextLabel}</h2>
          <p>Update the track-specific tags without changing the album-level metadata.</p>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close track tag editor">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="tag-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <div className="tag-editor-grid">
          <label className="field tag-editor-grid-span">
            <span>Track Name</span>
            <input value={values.title} onChange={(event) => onChange({ title: event.target.value })} />
          </label>
          <label className="field">
            <span>Track Number</span>
            <input value={values.trackNumber} onChange={(event) => onChange({ trackNumber: event.target.value })} inputMode="numeric" />
          </label>
          <label className="field">
            <span>Disc Number</span>
            <input value={values.discNumber} onChange={(event) => onChange({ discNumber: event.target.value })} inputMode="numeric" />
          </label>
        </div>

        {error ? <p className="error-banner inline">{error}</p> : null}

        <div className="identify-footer">
          <button type="button" className="pill-button ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="cta-button" disabled={busy}>
            {busy ? "Saving..." : "Save Tags"}
          </button>
        </div>
      </form>
    </div>
  </div>
);

const TrackList = ({
  tracks,
  currentTrackId,
  likedTrackIds,
  onPlayTrack,
  onEditTags,
  onToggleLike,
  onAddToPlaylist,
  onAddNextToQueue,
  onAddLastToQueue,
  isCurrentTrackPlaying,
  showArtistColumn = true
}: {
  tracks: TrackRecord[];
  currentTrackId: string | null;
  likedTrackIds: Set<string>;
  onPlayTrack: (track: TrackRecord, index: number) => void;
  onEditTags: (track: TrackRecord) => void;
  onToggleLike: (track: TrackRecord) => void;
  onAddToPlaylist: (track: TrackRecord) => void;
  onAddNextToQueue: (track: TrackRecord) => void;
  onAddLastToQueue: (track: TrackRecord) => void;
  isCurrentTrackPlaying?: boolean;
  showArtistColumn?: boolean;
}) => (
  <div className="track-list-table">
    <div className="track-list-head">
      <span />
      <span>#</span>
      <span>Title</span>
      {showArtistColumn ? <span>Artist</span> : null}
      <span>Time</span>
      <span className="track-list-head-actions">Actions</span>
    </div>
    {tracks.map((track, index) => (
      <div key={track.id} className={currentTrackId === track.id ? "track-list-row active" : "track-list-row"}>
        <button className="track-play-button" onClick={() => onPlayTrack(track, index)} aria-label={`Play ${track.title ?? "track"}`}>
          {currentTrackId === track.id ? <NowPlayingGlyph animated={isCurrentTrackPlaying} /> : <Play className="h-4 w-4" />}
        </button>
        <span className="track-index">{track.trackNumber ?? index + 1}</span>
        <div className="track-list-main">
          <strong>{track.title ?? "Untitled track"}</strong>
          <span className="track-list-subtitle">{track.album ?? "Unknown album"}</span>
        </div>
        {showArtistColumn ? <span className="track-list-artist">{getTrackDisplayArtist(track)}</span> : null}
        <span className="track-list-time">{formatTrackTime(track.durationSeconds)}</span>
        <div className="track-row-actions">
          <button className="song-action-button" onClick={() => onEditTags(track)} aria-label="Edit ID3 tags">
            <FilePenLine className="h-4 w-4" />
          </button>
          <button
            className={likedTrackIds.has(track.id) ? "song-action-button active" : "song-action-button"}
            onClick={() => onToggleLike(track)}
            aria-label={likedTrackIds.has(track.id) ? "Unlike song" : "Like song"}
          >
            <Heart className="h-4 w-4" fill={likedTrackIds.has(track.id) ? "currentColor" : "none"} />
          </button>
          <button className="song-action-button" onClick={() => onAddToPlaylist(track)} aria-label="Add to playlist">
            <ListMusic className="h-4 w-4" />
          </button>
          <button className="song-action-button" onClick={() => onAddNextToQueue(track)} aria-label="Add to next position in play queue">
            <ListStart className="h-4 w-4" />
          </button>
          <button className="song-action-button" onClick={() => onAddLastToQueue(track)} aria-label="Add to end of play queue">
            <ListEnd className="h-4 w-4" />
          </button>
        </div>
      </div>
    ))}
  </div>
);

const SettingsForm = ({
  initialSettings,
  scan,
  jobs,
  build,
  logs,
  busy,
  scanBusy,
  jobsBusy,
  error,
  onSubmit,
  onScanLibraryRoot,
  onScanBookRoot,
  onRunMobileCoverJobNow,
  onClose,
  title,
  description,
  actionLabel,
  pageMode = false
}: {
  initialSettings: AppSettings;
  scan: AppBootstrap["scan"];
  jobs: AppBootstrap["jobs"];
  build: AppBootstrap["build"];
  logs: DebugLogEntry[];
  busy: boolean;
  scanBusy: boolean;
  jobsBusy: boolean;
  error: string | null;
  onSubmit: (settings: AppSettings) => Promise<void>;
  onScanLibraryRoot: (settings: AppSettings, root: string) => Promise<void>;
  onScanBookRoot: (settings: AppSettings, root: string) => Promise<void>;
  onRunMobileCoverJobNow: () => Promise<void>;
  onClose: () => void;
  title: string;
  description: string;
  actionLabel: string;
  pageMode?: boolean;
}) => {
  const initialLibraryRoot = initialSettings.libraryRoots[0] ?? "";
  const initialBookRoot = initialSettings.bookRoots[0] ?? "";
  const initialScanInterval = String(initialSettings.scanIntervalMinutes);
  const initialMobileOptimizedCoversEnabled = initialSettings.mobileOptimizedCoversEnabled;
  const initialMobileOptimizedCoverJobTime = initialSettings.mobileOptimizedCoverJobTime;

  const [rootPath, setRootPath] = useState(initialLibraryRoot);
  const [bookRootPath, setBookRootPath] = useState(initialBookRoot);
  const [scanIntervalMinutes, setScanIntervalMinutes] = useState(String(initialSettings.scanIntervalMinutes));
  const [mobileOptimizedCoversEnabled, setMobileOptimizedCoversEnabled] = useState(initialMobileOptimizedCoversEnabled);
  const [mobileOptimizedCoverJobTime, setMobileOptimizedCoverJobTime] = useState(initialMobileOptimizedCoverJobTime);
  const [showScanDetails, setShowScanDetails] = useState(false);
  const [scanElapsedMs, setScanElapsedMs] = useState(0);
  const [scanTarget, setScanTarget] = useState<"music" | "books" | null>(null);
  const [activeTab, setActiveTab] = useState<"general" | "folders" | "jobs" | "logs">("folders");
  const [copyLogState, setCopyLogState] = useState<"idle" | "copied" | "failed">("idle");
  const mobileCoverJob = jobs.scheduled.find((job) => job.id === "mobile-cover-art") ?? null;
  const [jobElapsedMs, setJobElapsedMs] = useState(0);

  useEffect(() => {
    setRootPath(initialLibraryRoot);
    setBookRootPath(initialBookRoot);
    setScanIntervalMinutes(initialScanInterval);
    setMobileOptimizedCoversEnabled(initialMobileOptimizedCoversEnabled);
    setMobileOptimizedCoverJobTime(initialMobileOptimizedCoverJobTime);
  }, [initialBookRoot, initialLibraryRoot, initialMobileOptimizedCoverJobTime, initialMobileOptimizedCoversEnabled, initialScanInterval]);

  useEffect(() => {
    if (!scanBusy) {
      setScanTarget(null);
    }
  }, [scanBusy]);

  useEffect(() => {
    if (copyLogState === "idle") {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopyLogState("idle"), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copyLogState]);

  useEffect(() => {
    if (!mobileCoverJob?.isRunning || !mobileCoverJob.lastStartedAt) {
      setJobElapsedMs(0);
      return;
    }

    const startedAt = new Date(mobileCoverJob.lastStartedAt).getTime();

    const updateElapsed = () => {
      setJobElapsedMs(Math.max(0, Date.now() - startedAt));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);

    return () => window.clearInterval(intervalId);
  }, [mobileCoverJob?.isRunning, mobileCoverJob?.lastStartedAt]);

  useEffect(() => {
    if (!scan.isScanning || !scan.lastStartedAt) {
      setScanElapsedMs(0);
      return;
    }

    const startedAt = new Date(scan.lastStartedAt).getTime();

    const updateElapsed = () => {
      setScanElapsedMs(Math.max(0, Date.now() - startedAt));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);

    return () => window.clearInterval(intervalId);
  }, [scan.isScanning, scan.lastStartedAt]);

  const hasUnsavedChanges =
    rootPath.trim() !== initialLibraryRoot ||
    bookRootPath.trim() !== initialBookRoot ||
    scanIntervalMinutes !== initialScanInterval ||
    mobileOptimizedCoversEnabled !== initialMobileOptimizedCoversEnabled ||
    mobileOptimizedCoverJobTime !== initialMobileOptimizedCoverJobTime;

  const handleClose = () => {
    if (hasUnsavedChanges && !window.confirm("Discard unsaved library settings changes?")) {
      return;
    }

    onClose();
  };

  const buildSettingsPayload = (): AppSettings => ({
    libraryRoots: [rootPath.trim()],
    bookRoots: bookRootPath.trim() ? [bookRootPath.trim()] : [],
    scanIntervalMinutes: Number(scanIntervalMinutes),
    queueAlbumTracksOnPlay: initialSettings.queueAlbumTracksOnPlay,
    promptBeforeReplacingQueueOnPlay: initialSettings.promptBeforeReplacingQueueOnPlay,
    showEntityMetadataOnHeroImage: initialSettings.showEntityMetadataOnHeroImage,
    mobileOptimizedCoversEnabled,
    mobileOptimizedCoverJobTime
  });

  const scanElapsedLabel = (() => {
    const totalSeconds = Math.floor(scanElapsedMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  })();
  const currentScanPhaseLabel =
    scan.currentPhase === "discovering"
      ? "Discovering files"
      : scan.currentPhase === "reading"
        ? "Reading metadata"
        : scan.currentPhase === "finalizing"
          ? "Finalizing scan"
          : null;
  const secondsSinceLastProgress = scan.isScanning && scan.lastProgressAt
    ? Math.max(0, Math.floor((Date.now() - new Date(scan.lastProgressAt).getTime()) / 1000))
    : null;
  const scanHeartbeatLabel = secondsSinceLastProgress === null
    ? null
    : secondsSinceLastProgress < 10
      ? "Active just now"
      : secondsSinceLastProgress < 60
        ? `Active ${secondsSinceLastProgress}s ago`
        : `Active ${Math.floor(secondsSinceLastProgress / 60)}m ago`;
  const currentScanStepLabel = scan.currentStepLabel ?? currentScanPhaseLabel;
  const formatElapsed = (elapsedMs: number) => {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };
  const tabItems: Array<{ id: "general" | "folders" | "jobs" | "logs"; label: string; icon: LucideIcon }> = [
    { id: "general", label: "General", icon: Settings },
    { id: "folders", label: "Folders", icon: Library },
    { id: "jobs", label: "Jobs", icon: Clock3 },
    { id: "logs", label: "Logs", icon: Logs }
  ];
  const logText = logs
    .map((entry) => `[${new Date(entry.at).toLocaleString()}] ${entry.level.toUpperCase()} ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`)
    .join("\n\n");

  return (
    <form
      className={pageMode ? "auth-form settings-shell settings-page-form" : "auth-form settings-shell"}
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit(buildSettingsPayload());
      }}
    >
      <div className={pageMode ? "dialog-header settings-page-header" : "dialog-header"}>
        <div className="modal-copy">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {pageMode ? (
          <button className="cta-button settings-save-button" disabled={busy}>
            {busy ? "Saving..." : actionLabel}
          </button>
        ) : (
          <button type="button" className="close-button" onClick={handleClose} aria-label="Close library settings">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {error ? <p className="error-banner">{error}</p> : null}
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {tabItems.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "settings-tab-button is-active" : "settings-tab-button"}
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </nav>
        <section className="settings-panel">
          {activeTab === "general" ? (
            <div className="settings-empty-state">
              <div className="scan-status-row">
                <strong>Build information</strong>
                <span>Running instance details</span>
              </div>
              <div className="settings-build-grid">
                <div className="settings-build-item">
                  <span>App version</span>
                  <strong>{build.appVersion}</strong>
                </div>
                <div className="settings-build-item">
                  <span>Server version</span>
                  <strong>{build.serverVersion}</strong>
                </div>
                <div className="settings-build-item">
                  <span>Web version</span>
                  <strong>{build.webVersion}</strong>
                </div>
                <div className="settings-build-item">
                  <span>Shared version</span>
                  <strong>{build.sharedVersion}</strong>
                </div>
                <div className="settings-build-item settings-build-item-wide">
                  <span>Server started</span>
                  <strong>{new Date(build.serverStartedAt).toLocaleString()}</strong>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "folders" ? (
            <>
              <div className="scan-status-card">
                <div className="scan-status-row">
                  <strong>{scan.isScanning ? "Library scan in progress" : "Library scan idle"}</strong>
                  <span>{scan.progressPercent}%</span>
                </div>
                <div className="scan-status-row muted">
                  <span>
                    {scan.isScanning
                      ? `${scan.processedFiles} of ${scan.totalFiles} files processed in ${scanElapsedLabel}`
                      : scan.lastCompletedAt
                        ? `Last completed ${new Date(scan.lastCompletedAt).toLocaleString()}`
                        : "No completed scan yet"}
                  </span>
                  <span>{scan.queued ? "Another scan is queued" : scanHeartbeatLabel ?? ""}</span>
                </div>
                <div className="scan-progress-bar" aria-hidden="true">
                  <div className="scan-progress-fill" style={{ width: `${scan.progressPercent}%` }} />
                </div>
                {scan.isScanning && currentScanStepLabel ? (
                  <div className="scan-status-row muted">
                    <span>{currentScanStepLabel}</span>
                    {scan.phaseTotalItems > 0 ? <span>{scan.phaseProcessedItems} of {scan.phaseTotalItems}</span> : null}
                  </div>
                ) : null}
                <div className="scan-actions-row">
                  <button type="button" className="ghost-inline-button scan-details-toggle inline-flex items-center gap-2" onClick={() => setShowScanDetails((previous) => !previous)}>
                    {showScanDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    <span>Details</span>
                    <span>({scan.recentErrors.length} issues)</span>
                  </button>
                </div>
                {showScanDetails ? (
                  <div className="scan-errors-pane">
                    {scan.isScanning && (currentScanPhaseLabel || scan.currentFilePath) ? (
                      <div className="scan-details-current">
                        <strong>{currentScanStepLabel ?? currentScanPhaseLabel ?? "Working"}</strong>
                        {scan.phaseTotalItems > 0 ? <span>{scan.phaseProcessedItems} of {scan.phaseTotalItems}</span> : null}
                        <span title={scan.currentFilePath ?? undefined}>{scan.currentFilePath ?? ""}</span>
                        {scanHeartbeatLabel ? <span>{scanHeartbeatLabel}</span> : null}
                      </div>
                    ) : null}
                    {scan.recentErrors.length === 0 ? (
                      <p>No recent scan errors.</p>
                    ) : (
                      scan.recentErrors.map((issue: ScanError) => (
                        <article key={`${issue.filePath}-${issue.at}`} className="scan-error-item">
                          <strong>{issue.message}</strong>
                          <span>{issue.filePath}</span>
                        </article>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              <label className="field">
                <span>Music folder root</span>
                <div className="field-with-action">
                  <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="C:\\Users\\you\\Music" required />
                  <button
                    type="button"
                    className="pill-button field-action-button"
                    onClick={async () => {
                      setScanTarget("music");
                      await onScanLibraryRoot(buildSettingsPayload(), rootPath.trim());
                    }}
                    disabled={scanBusy || rootPath.trim().length === 0}
                  >
                    {scanBusy && scanTarget === "music" ? "Scanning..." : "Scan"}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Book folder</span>
                <div className="field-with-action">
                  <input value={bookRootPath} onChange={(event) => setBookRootPath(event.target.value)} placeholder="C:\\Users\\you\\Audiobooks" />
                  <button
                    type="button"
                    className="pill-button field-action-button"
                    onClick={async () => {
                      setScanTarget("books");
                      await onScanBookRoot(buildSettingsPayload(), bookRootPath.trim());
                    }}
                    disabled={scanBusy || bookRootPath.trim().length === 0}
                  >
                    {scanBusy && scanTarget === "books" ? "Scanning..." : "Scan"}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Scan interval in minutes</span>
                <input value={scanIntervalMinutes} onChange={(event) => setScanIntervalMinutes(event.target.value)} inputMode="numeric" required />
              </label>
            </>
          ) : null}

          {activeTab === "jobs" ? (
            <div className="scan-status-card">
              <div className="scan-status-row">
                <strong>{mobileCoverJob?.label ?? "Generate mobile cover art"}</strong>
                <button
                  type="button"
                  className="pill-button ghost"
                  onClick={() => void onRunMobileCoverJobNow()}
                  disabled={jobsBusy || mobileCoverJob?.isRunning || !mobileOptimizedCoversEnabled}
                >
                  {mobileCoverJob?.isRunning ? "Running..." : jobsBusy ? "Starting..." : "Run Now"}
                </button>
              </div>
              <p className="settings-job-copy">{mobileCoverJob?.description ?? "Create cropped mobile artwork for faster Android browsing."}</p>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={mobileOptimizedCoversEnabled}
                  onChange={(event) => setMobileOptimizedCoversEnabled(event.target.checked)}
                />
                <div className="toggle-copy">
                  <strong>Enable scheduled job</strong>
                  <span>Create `cover_mobile500x500.jpg` files for Android-friendly remote and offline artwork.</span>
                </div>
              </label>
              <label className="field">
                <span>Daily run time</span>
                <input
                  type="time"
                  value={mobileOptimizedCoverJobTime}
                  onChange={(event) => setMobileOptimizedCoverJobTime(event.target.value)}
                  disabled={!mobileOptimizedCoversEnabled}
                  required
                />
              </label>
              <div className="scan-status-row muted">
                <span>
                  {mobileCoverJob?.isRunning
                    ? `${mobileCoverJob.processedItems} of ${mobileCoverJob.totalItems} folders processed in ${formatElapsed(jobElapsedMs)}`
                    : mobileCoverJob?.lastCompletedAt
                      ? `Last completed ${new Date(mobileCoverJob.lastCompletedAt).toLocaleString()}`
                      : "No completed run yet"}
                </span>
                <span>{mobileOptimizedCoversEnabled ? `Scheduled for ${mobileOptimizedCoverJobTime}` : "Disabled"}</span>
              </div>
              <div className="scan-progress-bar" aria-hidden="true">
                <div className="scan-progress-fill" style={{ width: `${mobileCoverJob?.progressPercent ?? 0}%` }} />
              </div>
              {mobileCoverJob?.currentItemPath ? (
                <div className="scan-details-current">
                  <strong>Current folder</strong>
                  <span title={mobileCoverJob.currentItemPath}>{mobileCoverJob.currentItemPath}</span>
                </div>
              ) : null}
              {mobileCoverJob?.lastError ? (
                <div className="scan-errors-pane">
                  <article className="scan-error-item">
                    <strong>Last run error</strong>
                    <span>{mobileCoverJob.lastError}</span>
                  </article>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "logs" ? (
            <div className="scan-status-card">
              <div className="scan-status-row">
                <strong>Debug log</strong>
                <button
                  type="button"
                  className="pill-button ghost"
                  onClick={() => {
                    void (async () => {
                      const copied = await copyTextToClipboard(logText);
                      setCopyLogState(copied ? "copied" : "failed");
                    })();
                  }}
                >
                  {copyLogState === "copied" ? "Copied" : copyLogState === "failed" ? "Press Ctrl+C" : "Copy log"}
                </button>
              </div>
              <p className="settings-job-copy">Startup, fetch, route, and browser diagnostics for investigating slow loading.</p>
              <div className="settings-log-list" role="log" aria-live="polite" tabIndex={0}>
                {logs.length === 0 ? (
                  <p className="settings-log-empty">No log entries yet.</p>
                ) : (
                  <pre className="settings-log-plain">{logText}</pre>
                )}
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <button className={`cta-button full-width${pageMode ? " settings-page-bottom-save" : ""}`} disabled={busy}>
        {busy ? "Saving..." : actionLabel}
      </button>
    </form>
  );
};

const UserSettingsDialog = ({
  user,
  status,
  generatedApiKey,
  settings,
  busy,
  settingsBusy,
  copied,
  onGenerate,
  onDelete,
  onCopy,
  onClose,
  onSaveSettings
}: {
  user: { name: string; email: string };
  status: UserApiKeyStatus | null;
  generatedApiKey: string | null;
  settings: AppSettings;
  busy: boolean;
  settingsBusy: boolean;
  copied: boolean;
  onGenerate: () => Promise<void>;
  onDelete: () => Promise<void>;
  onCopy: () => Promise<void>;
  onClose: () => void;
  onSaveSettings: (settings: AppSettings) => Promise<boolean>;
}) => {
  return (
    <div className="modal-scrim">
      <div className="auth-card">
        <div className="auth-form">
          <div className="dialog-header">
            <div className="modal-copy">
              <h2>User Settings</h2>
              <p>Manage your OpenSubsonic API key and playback defaults.</p>
            </div>
            <button type="button" className="close-button" onClick={onClose} aria-label="Close user settings">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="scan-status-card">
            <div className="scan-status-row">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            <div className="scan-status-row muted">
              <span>OpenSubsonic username</span>
              <span>{status?.subsonicUsername ?? "Loading..."}</span>
            </div>
            <div className="scan-status-row muted">
              <span>Server endpoint</span>
              <span>{status?.apiBaseUrl ?? "Loading..."}</span>
            </div>
          </div>

          <div className="scan-status-card">
            <div className="scan-status-row">
              <strong className="inline-flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                OpenSubsonic API key
              </strong>
              <span>{status?.hasApiKey ? status.preview : "No key"}</span>
            </div>
            <div className="scan-status-row muted">
              <span>{status?.hasApiKey ? "A key is active for this user." : "Generate a key for apps like Symfonium."}</span>
              <span>{status?.createdAt ? new Date(status.createdAt).toLocaleString() : "Not created yet"}</span>
            </div>

            {generatedApiKey ? (
              <label className="field">
                <span>Copy this key now. It will not be shown again.</span>
                <div className="generated-key-row">
                  <input value={generatedApiKey} readOnly />
                  <button type="button" className="ghost-inline-button generated-key-copy" onClick={() => void onCopy()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </label>
            ) : null}

            <div className="api-key-actions">
              <button type="button" className="cta-button" onClick={() => void onGenerate()} disabled={busy}>
                {busy ? "Generating..." : status?.hasApiKey ? "Replace API key" : "Generate API key"}
              </button>
              <button
                type="button"
                className="pill-button ghost inline-flex items-center gap-2"
                onClick={() => void onDelete()}
                disabled={busy || !status?.hasApiKey}
              >
                <Trash2 className="h-4 w-4" />
                Delete API key
              </button>
            </div>
          </div>

          <div className="scan-status-card">
            <div className="scan-status-row">
              <strong>Playback</strong>
              <span>Controls how track clicks behave</span>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.queueAlbumTracksOnPlay}
                disabled={settingsBusy}
                onChange={(event) =>
                  void onSaveSettings({
                    ...settings,
                    queueAlbumTracksOnPlay: event.target.checked
                  })
                }
              />
              <span className="toggle-copy">
                <strong>Queue the rest of the selection</strong>
                <span>When you click Play on a track, include the following tracks from that album or list.</span>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.promptBeforeReplacingQueueOnPlay}
                disabled={settingsBusy}
                onChange={(event) =>
                  void onSaveSettings({
                    ...settings,
                    promptBeforeReplacingQueueOnPlay: event.target.checked
                  })
                }
              />
              <span className="toggle-copy">
                <strong>Prompt before replacing the queue</strong>
                <span>Ask before clearing the current queue when you start a new track.</span>
              </span>
            </label>
          </div>

          <div className="scan-status-card">
            <div className="scan-status-row">
              <strong>Appearance</strong>
              <span>Hero image presentation on detail pages</span>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.showEntityMetadataOnHeroImage}
                disabled={settingsBusy}
                onChange={(event) =>
                  void onSaveSettings({
                    ...settings,
                    showEntityMetadataOnHeroImage: event.target.checked
                  })
                }
              />
              <span className="toggle-copy">
                <strong>Overlay entity details on list art</strong>
                <span>Show the title and metadata on top of the cover image on the albums, artists, playlists, and books listing screens.</span>
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};

export const App = () => {
  hydratePreviewSessionToken();
  const initialRoute = parseRouteState();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoplayRequestedRef = useRef(false);
  const lastHistoryTrackIdRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const currentTrackRef = useRef<TrackRecord | null>(null);
  const playQueueRef = useRef<TrackRecord[]>([]);
  const queueLabelRef = useRef("No queue");
  const currentTimeRef = useRef(0);
  const progressSaveRef = useRef<string>("");
  const routeRenderMeasureRef = useRef<{ routeKey: string; startedAt: number } | null>(null);
  const lastBootstrapSignatureRef = useRef<string | null>(null);

  const [view, setView] = useState<ViewName>(initialRoute.view);
  const [libraryBrowseMode, setLibraryBrowseMode] = useState<LibraryBrowseMode>("all");
  const [selectedGenreFilter, setSelectedGenreFilter] = useState<string>("all");
  const [selectedBookGenreFilters, setSelectedBookGenreFilters] = useState<string[]>([]);
  const [libraryTrackFilter, setLibraryTrackFilter] = useState("");
  const [libraryRecentlyAddedOnly, setLibraryRecentlyAddedOnly] = useState(false);
  const [libraryBooksFilterMenuOpen, setLibraryBooksFilterMenuOpen] = useState(false);
  const [showCompletedBooks, setShowCompletedBooks] = useState(true);
  const [showInProgressBooks, setShowInProgressBooks] = useState(true);
  const [showCachedBooks, setShowCachedBooks] = useState(true);
  const [libraryBooksSort, setLibraryBooksSort] = useState<LibraryBooksSortOption>("default");
  const [libraryAuthorsFilterMenuOpen, setLibraryAuthorsFilterMenuOpen] = useState(false);
  const [libraryAuthorsSort, setLibraryAuthorsSort] = useState<LibraryAuthorsSortOption>("author");
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [data, setData] = useState<LibraryData | null>(null);
  const [likedTrackIds, setLikedTrackIds] = useState<Set<string>>(new Set());
  const [userPlaylists, setUserPlaylists] = useState<UserPlaylist[]>([]);
  const [recentlyPlayed, setRecentlyPlayed] = useState<TrackRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [folderScanBusy, setFolderScanBusy] = useState(false);
  const [jobsBusy, setJobsBusy] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("register");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [currentTrack, setCurrentTrack] = useState<TrackRecord | null>(null);
  const [playQueue, setPlayQueue] = useState<TrackRecord[]>([]);
  const [queueLabel, setQueueLabel] = useState("No queue");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(initialRoute.selectedAlbumId);
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(initialRoute.selectedArtistId);
  const [selectedAuthorId, setSelectedAuthorId] = useState<string | null>(initialRoute.selectedAuthorId);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(initialRoute.selectedPlaylistId);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(initialRoute.selectedBookId);
  const [selectedAlbumDetail, setSelectedAlbumDetail] = useState<AlbumDetailRecord | null>(null);
  const [selectedBookDetail, setSelectedBookDetail] = useState<BookDetailRecord | null>(null);
  const [albumDetailLoading, setAlbumDetailLoading] = useState(false);
  const [bookDetailLoading, setBookDetailLoading] = useState(false);
  const [albumIdentifyLoading, setAlbumIdentifyLoading] = useState(false);
  const [albumIdentifyPendingCandidateId, setAlbumIdentifyPendingCandidateId] = useState<number | null>(null);
  const [albumArtRefreshToken, setAlbumArtRefreshToken] = useState(0);
  const [albumIdentifyState, setAlbumIdentifyState] = useState<AlbumIdentifyState | null>(null);
  const [albumTagsEditorState, setAlbumTagsEditorState] = useState<AlbumTagsEditorState | null>(null);
  const [trackTagsEditorState, setTrackTagsEditorState] = useState<TrackTagsEditorState | null>(null);
  const [albumTagsSaving, setAlbumTagsSaving] = useState(false);
  const [trackTagsSaving, setTrackTagsSaving] = useState(false);
  const [albumTagsError, setAlbumTagsError] = useState<string | null>(null);
  const [trackTagsError, setTrackTagsError] = useState<string | null>(null);
  const [showAlbumBioDialog, setShowAlbumBioDialog] = useState(false);
  const [volume, setVolume] = useState(() => {
    const stored = window.localStorage.getItem(PLAYER_VOLUME_KEY);
    const parsed = stored ? Number(stored) : 0.8;
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.8;
  });
  const [showSettings, setShowSettings] = useState(initialRoute.showSettings);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(initialRoute.showMobileMenu);
  const [dismissSetupModal, setDismissSetupModal] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<UserApiKeyStatus | null>(null);
  const [generatedApiKeyValue, setGeneratedApiKeyValue] = useState<string | null>(null);
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [userSettingsBusy, setUserSettingsBusy] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [trackHeavyDataLoaded, setTrackHeavyDataLoaded] = useState(false);
  const [trackHeavyDataLoading, setTrackHeavyDataLoading] = useState(false);
  const [authForm, setAuthForm] = useState({
    name: "",
    email: "",
    password: ""
  });
  const deferredQuery = useDeferredValue(query);
  const appendDebugLog = (level: DebugLogEntry["level"], message: string, detail?: string) => {
    setDebugLogs((previous) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        level,
        message,
        detail
      },
      ...previous
    ].slice(0, 250));
  };
  const currentRoute: RouteState = {
    view,
    selectedAlbumId,
    selectedArtistId,
    selectedAuthorId,
    selectedPlaylistId,
    selectedBookId,
    showSettings,
    showMobileMenu
  };
  const currentRouteKey = buildRouteUrl(currentRoute);

  const syncRouteState = (nextRoute: RouteState) => {
    const nextRouteKey = buildRouteUrl(nextRoute);
    routeRenderMeasureRef.current = {
      routeKey: nextRouteKey,
      startedAt: performance.now()
    };
    appendDebugLog("info", "Route changed", `${currentRoute.view} -> ${nextRoute.view}`);
    startTransition(() => {
      setView(nextRoute.view);
      setSelectedAlbumId(nextRoute.selectedAlbumId);
      setSelectedArtistId(nextRoute.selectedArtistId);
      setSelectedAuthorId(nextRoute.selectedAuthorId);
      setSelectedPlaylistId(nextRoute.selectedPlaylistId);
      setSelectedBookId(nextRoute.selectedBookId);
      setShowSettings(nextRoute.showSettings);
      setShowMobileMenu(nextRoute.showMobileMenu);
    });
  };

  const applyRouteState = (nextRoute: RouteState, historyMode: "push" | "replace" | "none" = "push") => {
    const sanitizedRoute = sanitizeRouteState(nextRoute);
    syncRouteState(sanitizedRoute);

    if (historyMode === "none") {
      return;
    }

    const nextUrl = buildRouteUrl(sanitizedRoute);
    const currentUrl = `${window.location.pathname}${window.location.search}`;

    if (nextUrl === currentUrl) {
      if (!window.history.state?.mp3PlatformRoute) {
        window.history.replaceState({ mp3PlatformRoute: true }, "", nextUrl);
      }
      return;
    }

    if (historyMode === "replace") {
      window.history.replaceState({ mp3PlatformRoute: true }, "", nextUrl);
      return;
    }

    window.history.pushState({ mp3PlatformRoute: true }, "", nextUrl);
  };

  const updateRoute = (patch: Partial<RouteState>, options?: { replace?: boolean }) => {
    applyRouteState(
      {
        ...currentRoute,
        ...patch
      },
      options?.replace ? "replace" : "push"
    );
  };

  const navigateToView = (nextView: ViewName) => {
    updateRoute({
      view: nextView,
      showMobileMenu: false
    });
  };

  const scrollPageToTop = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  const submitSearch = () => {
    setQuery(searchDraft);

    if (view !== "search") {
      updateRoute({
        view: "search",
        showMobileMenu: false
      });
    }
  };

  const loadBootstrap = async () => {
    const startedAt = performance.now();

    try {
      const nextBootstrap = await fetchBootstrap();
      const normalizedBootstrap = {
        ...nextBootstrap,
        settings: normalizeAppSettings(nextBootstrap.settings)
      };
      setBootstrap(normalizedBootstrap);
      setAuthMode(nextBootstrap.hasUsers ? "login" : "register");
      const durationMs = Math.round(performance.now() - startedAt);
      const bootstrapSignature = `${nextBootstrap.hasUsers}:${nextBootstrap.currentUser?.email ?? "none"}:${nextBootstrap.needsLibrarySetup}:${nextBootstrap.scan.isScanning}:${nextBootstrap.jobs.scheduled.some((job) => job.isRunning)}`;

      if (lastBootstrapSignatureRef.current !== bootstrapSignature || durationMs >= 250) {
        appendDebugLog(
          durationMs >= 250 ? "warn" : "info",
          "Bootstrap poll completed",
          `${durationMs}ms | hasUsers=${String(nextBootstrap.hasUsers)} | currentUser=${nextBootstrap.currentUser?.email ?? "none"} | needsLibrarySetup=${String(nextBootstrap.needsLibrarySetup)} | scanRunning=${String(nextBootstrap.scan.isScanning)}`
        );
      }

      lastBootstrapSignatureRef.current = bootstrapSignature;
      return normalizedBootstrap;
    } catch (error) {
      appendDebugLog("error", "Bootstrap request failed", error instanceof Error ? error.message : "Unknown bootstrap error");
      throw error;
    }
  };

  const loadLibrary = async () => {
    setLibraryLoading(true);
    const startedAt = performance.now();
    appendDebugLog("info", "Library shell load started");

    try {
      const timed = async <T,>(label: string, loader: () => Promise<T>) => {
        const timerStart = performance.now();
        const result = await loader();
        appendDebugLog("info", `${label} loaded`, `${Math.round(performance.now() - timerStart)}ms`);
        return result;
      };

      const [summary, artists, albums, books, likes] = await Promise.all([
        timed("Summary", fetchLibrarySummary),
        timed("Artists", fetchArtists),
        timed("Albums", fetchAlbums),
        timed("Books", fetchBooks),
        timed("Likes", fetchLikedTrackIds)
      ]);
      setTrackHeavyDataLoaded(false);
      setData((previous) => ({
        summary,
        tracks: previous?.tracks ?? [],
        artists,
        albums,
        books,
        playlists: previous?.playlists ?? []
      }));
      setLikedTrackIds(new Set(likes.trackIds));
      appendDebugLog(
        "info",
        "Library shell load completed",
        `${Math.round(performance.now() - startedAt)}ms | albums=${albums.length} | artists=${artists.length} | books=${books.length}`
      );
    } catch (error) {
      appendDebugLog("error", "Library shell load failed", error instanceof Error ? error.message : "Unknown library load error");
      throw error;
    } finally {
      setLibraryLoading(false);
    }
  };

  const loadTrackHeavyData = async (options?: { force?: boolean }) => {
    if (trackHeavyDataLoading && !options?.force) {
      return;
    }

    if (trackHeavyDataLoaded && !options?.force) {
      return;
    }

    setTrackHeavyDataLoading(true);
    const startedAt = performance.now();
    appendDebugLog("info", "Track-heavy library load started");

    try {
      const timed = async <T,>(label: string, loader: () => Promise<T>) => {
        const timerStart = performance.now();
        const result = await loader();
        appendDebugLog("info", `${label} loaded`, `${Math.round(performance.now() - timerStart)}ms`);
        return result;
      };

      const [tracks, playlists, recent] = await Promise.all([
        timed("Tracks", fetchTracks),
        timed("Playlists", fetchPlaylists),
        timed("Recently played", fetchRecentlyPlayed)
      ]);
      setData((previous) => previous
        ? {
            ...previous,
            tracks,
            playlists: playlists.filter((playlist) => playlist.isSmart)
          }
        : null);
      setUserPlaylists(playlists.filter((playlist) => !playlist.isSmart));
      setRecentlyPlayed(recent);
      setCurrentTrack((previous) => (previous ? tracks.find((track) => track.id === previous.id) ?? previous : tracks[0] ?? null));
      setPlayQueue((previous) => previous.map((queuedTrack) => tracks.find((track) => track.id === queuedTrack.id) ?? queuedTrack));
      setTrackHeavyDataLoaded(true);
      appendDebugLog(
        "info",
        "Track-heavy library load completed",
        `${Math.round(performance.now() - startedAt)}ms | tracks=${tracks.length} | playlists=${playlists.length} | recent=${recent.length}`
      );
    } catch (error) {
      appendDebugLog("error", "Track-heavy library load failed", error instanceof Error ? error.message : "Unknown track-heavy library load error");
      throw error;
    } finally {
      setTrackHeavyDataLoading(false);
    }
  };

  const loadFullLibrary = async () => {
    await loadLibrary();
    await loadTrackHeavyData({ force: true });
  };

  useEffect(() => {
    const navigatorWithExtras = navigator as Navigator & {
      deviceMemory?: number;
      connection?: {
        effectiveType?: string;
        downlink?: number;
        rtt?: number;
        saveData?: boolean;
      };
    };

    appendDebugLog(
      "info",
      "Browser session started",
      [
        `url=${window.location.href}`,
        `userAgent=${navigator.userAgent}`,
        `viewport=${window.innerWidth}x${window.innerHeight}`,
        `cores=${navigator.hardwareConcurrency ?? "unknown"}`,
        `memory=${navigatorWithExtras.deviceMemory ?? "unknown"}GB`,
        `network=${navigatorWithExtras.connection?.effectiveType ?? "unknown"}`,
        `downlink=${navigatorWithExtras.connection?.downlink ?? "unknown"}Mb/s`,
        `rtt=${navigatorWithExtras.connection?.rtt ?? "unknown"}ms`,
        `saveData=${String(navigatorWithExtras.connection?.saveData ?? false)}`
      ].join(" | ")
    );

    const run = async () => {
      setLoading(true);
      setError(null);

      try {
        const nextBootstrap = await loadBootstrap();

        if (nextBootstrap.currentUser && !nextBootstrap.needsLibrarySetup) {
          await loadLibrary();
          void loadTrackHeavyData();
        }
      } catch (nextError) {
        appendDebugLog("error", "Initial application load failed", nextError instanceof Error ? nextError.message : "Failed to load app");
        setError(nextError instanceof Error ? nextError.message : "Failed to load app");
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, []);

  useEffect(() => {
    const normalizedRoute = sanitizeRouteState(parseRouteState());
    const normalizedUrl = buildRouteUrl(normalizedRoute);
    const currentUrl = `${window.location.pathname}${window.location.search}`;

    if (normalizedUrl !== currentUrl || !window.history.state?.mp3PlatformRoute) {
      window.history.replaceState({ mp3PlatformRoute: true }, "", normalizedUrl);
    }

    const handlePopState = () => {
      syncRouteState(sanitizeRouteState(parseRouteState()));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    setSearchDraft(query);
  }, [query]);

  useEffect(() => {
    if (!bootstrap?.currentUser || !data || trackHeavyDataLoaded || trackHeavyDataLoading) {
      return;
    }

    if (isTrackHeavyView(view) || deferredQuery.trim().length > 0) {
      void loadTrackHeavyData();
    }
  }, [bootstrap?.currentUser, data, deferredQuery, trackHeavyDataLoaded, trackHeavyDataLoading, view]);

  useEffect(() => {
    if (!bootstrap?.currentUser) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadBootstrap();
    }, bootstrap.scan.isScanning || bootstrap.jobs.scheduled.some((job) => job.isRunning) ? 1500 : 5000);

    return () => window.clearInterval(intervalId);
  }, [bootstrap?.currentUser, bootstrap?.scan.isScanning, bootstrap?.jobs]);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  useEffect(() => {
    playQueueRef.current = playQueue;
  }, [playQueue]);

  useEffect(() => {
    queueLabelRef.current = queueLabel;
  }, [queueLabel]);

  useEffect(() => {
    currentTimeRef.current = currentTimeSeconds;
  }, [currentTimeSeconds]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    audio.volume = volume;
    window.localStorage.setItem(PLAYER_VOLUME_KEY, String(volume));
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const onPlay = () => {
      setIsPlaying(true);

      if (!currentTrack || lastHistoryTrackIdRef.current === currentTrack.id) {
        return;
      }

      lastHistoryTrackIdRef.current = currentTrack.id;
      setRecentlyPlayed((previous) => [currentTrack, ...previous.filter((track) => track.id !== currentTrack.id)].slice(0, 25));
      void recordTrackPlay(currentTrack.id).catch(() => undefined);
    };

    const onPause = () => {
      setIsPlaying(false);
      void persistBookProgress(currentTrackRef.current, Math.floor(audio.currentTime || 0), Math.floor(audio.duration || 0));
    };
    const onTimeUpdate = () => {
      setCurrentTimeSeconds(Math.floor(audio.currentTime || 0));
    };
    const onLoadedMetadata = () => {
      setDurationSeconds(Math.floor(audio.duration || 0));
    };
    const onDurationChange = () => {
      setDurationSeconds(Math.floor(audio.duration || currentTrack?.durationSeconds || 0));
    };
    const onEnded = () => {
      const finishedTrack = currentTrackRef.current;

      if (!finishedTrack) {
        setIsPlaying(false);
        return;
      }

      const activeQueue = playQueueRef.current;
      const currentIndex = activeQueue.findIndex((track) => track.id === finishedTrack.id);
      const nextTrack = currentIndex >= 0 && currentIndex < activeQueue.length - 1 ? activeQueue[currentIndex + 1] ?? null : null;

      if (!nextTrack) {
        void persistBookProgress(
          finishedTrack,
          Math.floor(audio.duration || finishedTrack.durationSeconds || 0),
          Math.floor(audio.duration || finishedTrack.durationSeconds || 0)
        );
        autoplayRequestedRef.current = false;
        setIsPlaying(false);
        return;
      }

      pendingSeekRef.current = 0;
      setCurrentTimeSeconds(0);
      void playTracks(activeQueue, queueLabelRef.current === "No queue" ? "Current Queue" : queueLabelRef.current, currentIndex + 1, {
        preserveQueue: true,
        skipQueueConfirmation: true
      });
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const track = currentTrackRef.current;

      if (!track?.bookId || !isPlaying) {
        return;
      }

      const audio = audioRef.current;
      const positionSeconds = Math.floor(audio?.currentTime ?? currentTimeRef.current ?? 0);
      const durationValue = Math.floor(audio?.duration ?? track.durationSeconds ?? 0);
      void persistBookProgress(track, positionSeconds, durationValue);
    }, 10000);

    const saveCurrentBookProgress = () => {
      const track = currentTrackRef.current;
      const audio = audioRef.current;

      if (!track?.bookId || !audio) {
        return;
      }

      void persistBookProgress(
        track,
        Math.floor(audio.currentTime || 0),
        Math.floor(audio.duration || track.durationSeconds || 0),
        { keepalive: true }
      );
    };

    window.addEventListener("beforeunload", saveCurrentBookProgress);
    window.addEventListener("pagehide", saveCurrentBookProgress);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("beforeunload", saveCurrentBookProgress);
      window.removeEventListener("pagehide", saveCurrentBookProgress);
    };
  }, [isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !currentTrack) {
      return;
    }

    const startPlayback = async () => {
      try {
        await audio.play();
        autoplayRequestedRef.current = false;
        setPlaybackError(null);
      } catch {
        setPlaybackError("Playback could not start. Check that the track is readable and try again.");
      }
    };

    const applyPendingSeek = () => {
      if (pendingSeekRef.current === null) {
        return;
      }

      audio.currentTime = pendingSeekRef.current;
      setCurrentTimeSeconds(Math.floor(pendingSeekRef.current));
      pendingSeekRef.current = null;
    };

    audio.src = getStreamUrl(currentTrack.id);
    setCurrentTimeSeconds(0);
    setDurationSeconds(currentTrack.durationSeconds ?? 0);
    audio.load();

    if (!autoplayRequestedRef.current) {
      return;
    }

    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      applyPendingSeek();
      void startPlayback();
      return;
    }

    const handleCanPlay = () => {
      applyPendingSeek();
      void startPlayback();
    };
    const handleLoadedMetadata = () => {
      applyPendingSeek();
    };
    audio.addEventListener("canplay", handleCanPlay, { once: true });
    audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
    return () => {
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [currentTrack]);

  useEffect(() => {
    if (!selectedAlbumId) {
      setSelectedAlbumDetail(null);
      return;
    }

    void loadSelectedAlbumDetail(selectedAlbumId);
  }, [selectedAlbumId]);

  useEffect(() => {
    if (!selectedBookId) {
      setSelectedBookDetail(null);
      return;
    }

    void loadSelectedBookDetail(selectedBookId);
  }, [selectedBookId]);

  const filteredData = useMemo(() => {
    if (!data) {
      return null;
    }

    const search = deferredQuery.trim().toLowerCase();

    if (!search) {
      return {
        ...data,
        playlists: data.playlists
      };
    }

    const tracks = data.tracks.filter((track) =>
      [track.title ?? "", track.artist ?? "", track.album ?? "", track.bookTitle ?? "", track.genre ?? ""].some((value) => value.toLowerCase().includes(search))
    );
    const albums = data.albums.filter((album) => [album.name, album.artist].some((value) => value.toLowerCase().includes(search)));
    const artists = data.artists.filter((artist) => artist.name.toLowerCase().includes(search));
    const books = data.books.filter((book) => [book.title, book.author].some((value) => value.toLowerCase().includes(search)));
    const playlistTrackIds = new Set(tracks.map((track) => track.id));
    const playlists = data.playlists
      .map((playlist) => ({
        ...playlist,
        tracks: playlist.tracks.filter((track) => playlistTrackIds.has(track.id))
      }))
      .filter((playlist) =>
        playlist.name.toLowerCase().includes(search) ||
        (playlist.description ?? "").toLowerCase().includes(search) ||
        playlist.tracks.length > 0
      );

    return {
      summary: data.summary,
      tracks,
      albums,
      artists,
      books,
      playlists
    };
  }, [data, deferredQuery]);

  const needsGlobalAlbumGroups = view === "home" || view === "search" || view === "albums" || view === "album" || view === "artist";
  const needsGlobalBookGroups = view === "search" || view === "books" || view === "book" || view === "authors" || view === "author";
  const needsGlobalArtistGroups = view === "search" || view === "artists" || view === "artist";
  const albumGroups = useMemo(
    () => (filteredData && needsGlobalAlbumGroups ? buildAlbumGroups(filteredData.albums, filteredData.tracks) : []),
    [filteredData, needsGlobalAlbumGroups]
  );
  const artistGroups = useMemo(
    () => (filteredData && needsGlobalArtistGroups ? buildArtistGroups(filteredData.artists, albumGroups) : []),
    [albumGroups, filteredData, needsGlobalArtistGroups]
  );
  const bookGroups = useMemo(
    () => (filteredData && needsGlobalBookGroups ? buildBookGroups(filteredData.books, filteredData.tracks) : []),
    [filteredData, needsGlobalBookGroups]
  );
  const featuredAlbum = albumGroups[0] ?? null;
  const recentAlbums = useMemo(() => albumGroups.slice(0, 5), [albumGroups]);
  const savedEarlierAlbums = useMemo(() => albumGroups.slice(5, 10), [albumGroups]);
  const trendingArtists = useMemo(() => filteredData?.artists.slice(0, 4) ?? [], [filteredData]);
  const searchAlbums = useMemo(() => albumGroups.slice(0, 8), [albumGroups]);
  const searchBooks = useMemo(() => bookGroups.slice(0, 8), [bookGroups]);
  const searchArtists = useMemo(() => artistGroups.slice(0, 8), [artistGroups]);
  const searchTracks = useMemo(() => filteredData?.tracks.slice(0, 20) ?? [], [filteredData]);
  const currentTrackArtist = currentTrack?.artist ?? "Choose a track to begin playback";
  const mobileCurrentTrackArtist = truncateLabel(currentTrackArtist, 35);
  const currentTrackAlbum = currentTrack?.album ?? "Unknown album";
  const mobileCurrentTrackAlbum = truncateLabel(currentTrackAlbum, 35);
  const playlists = useMemo(() => filteredData?.playlists ?? [], [filteredData]);
  const libraryItems = useMemo(() => filteredData?.tracks.slice(0, 12) ?? [], [filteredData]);
  const activeAlbumGroup = useMemo(() => albumGroups.find((album) => album.id === selectedAlbumId) ?? null, [albumGroups, selectedAlbumId]);
  const activeAlbum = selectedAlbumDetail?.album ?? activeAlbumGroup ?? null;
  const activeAlbumTracks = selectedAlbumDetail?.tracks ?? (activeAlbumGroup ? sortTracksByPlaybackOrder(activeAlbumGroup.tracks) : []);
  const activeAlbumBlurb =
    selectedAlbumDetail?.outline || selectedAlbumDetail?.review || selectedAlbumDetail?.artistOutline || selectedAlbumDetail?.artistBiography;
  const activeArtistGroup = useMemo(() => artistGroups.find((artist) => artist.id === selectedArtistId) ?? null, [artistGroups, selectedArtistId]);
  const activeArtistTracks = activeArtistGroup ? sortTracksByPlaybackOrder(activeArtistGroup.tracks) : [];
  const activeArtistAlbums = activeArtistGroup?.albums ?? [];
  const activeArtistCoverArtId = activeArtistAlbums[0]?.coverArtId ?? activeArtistTracks[0]?.coverArtId ?? null;
  const authorGroups = useMemo(() => buildAuthorGroups(bookGroups), [bookGroups]);
  const activeAuthorGroup = useMemo(() => authorGroups.find((author) => author.id === selectedAuthorId) ?? null, [authorGroups, selectedAuthorId]);
  const activeAuthorBooks = activeAuthorGroup?.books ?? [];
  const activeAuthorTracks = activeAuthorGroup?.tracks ?? [];
  const activeAuthorCoverArtId = activeAuthorGroup ? getAuthorListCoverArtId(activeAuthorGroup, filteredData?.summary.lastScanAt ?? null) : null;
  const activeBookGroup = useMemo(() => bookGroups.find((book) => book.id === selectedBookId) ?? null, [bookGroups, selectedBookId]);
  const activeBookTracks = selectedBookDetail?.tracks ?? activeBookGroup?.tracks ?? [];
  const activeBook =
    selectedBookDetail?.book || activeBookGroup
      ? {
          ...(selectedBookDetail?.book ?? activeBookGroup!),
          author: getBookDisplayAuthor(selectedBookDetail?.book ?? activeBookGroup!, activeBookTracks)
        }
      : null;
  const activeBookProgress =
    selectedBookDetail?.progress ??
    (activeBookGroup && activeBookGroup.lastTrackId && activeBookGroup.lastPositionSeconds !== null
      ? {
          bookId: activeBookGroup.id,
          trackId: activeBookGroup.lastTrackId,
          positionSeconds: activeBookGroup.lastPositionSeconds,
          updatedAt: activeBookGroup.lastListenedAt ?? ""
        }
      : null);
  const activeBookBookmark = getLatestMeaningfulBookmark(selectedBookDetail?.bookmarks, activeBookTracks);
  const activeBookResumePoint = hasMeaningfulBookProgress(activeBookProgress, activeBookTracks)
    ? activeBookProgress
    : activeBookBookmark;
  const activeBookHasResumeProgress = hasMeaningfulBookProgress(activeBookResumePoint, activeBookTracks);
  const activeBookCompleted = isBookCompleted(activeBookProgress, activeBookTracks);
  const activeBookInProgress = isBookInProgress(activeBookProgress, activeBookTracks);
  const activeAlbumBioText = activeAlbumBlurb || "This album was indexed from your local library and is ready for full ordered playback.";
  const desktopBackLink =
    view === "album"
      ? { label: "Back to albums", target: "albums" as ViewName }
      : view === "artist"
        ? { label: "Back to artists", target: "artists" as ViewName }
        : view === "author"
          ? { label: "Back to authors", target: "authors" as ViewName }
        : view === "playlist"
          ? { label: "Back to playlists", target: "playlists" as ViewName }
          : view === "book"
            ? { label: "Back to books", target: "books" as ViewName }
            : null;
  const isLibraryView = view === "library";
  const libraryGenreSourceTracks = useMemo(() => {
    if (!filteredData || !isLibraryView) {
      return [];
    }

    if (libraryBrowseMode === "books" || libraryBrowseMode === "authors") {
      return filteredData.tracks.filter((track) => track.mediaKind === "book");
    }

    if (libraryBrowseMode === "albums" || libraryBrowseMode === "artists") {
      return filteredData.tracks.filter((track) => track.mediaKind !== "book");
    }

    return filteredData.tracks;
  }, [filteredData, isLibraryView, libraryBrowseMode]);
  const libraryGenres = useMemo(() => {
    return normalizeGenreLabels(libraryGenreSourceTracks.map((track) => track.genre))
      .sort((left, right) => left.localeCompare(right));
  }, [libraryGenreSourceTracks]);
  useEffect(() => {
    if (selectedGenreFilter !== "all" && !libraryGenres.includes(selectedGenreFilter)) {
      setSelectedGenreFilter("all");
    }
  }, [libraryGenres, selectedGenreFilter]);
  useEffect(() => {
    setSelectedBookGenreFilters((previous) => previous.filter((genre) => libraryGenres.includes(genre)));
  }, [libraryGenres]);
  useEffect(() => {
    if (libraryBrowseMode !== "books") {
      setLibraryBooksFilterMenuOpen(false);
    }
  }, [libraryBrowseMode]);
  useEffect(() => {
    if (libraryBrowseMode !== "authors") {
      setLibraryAuthorsFilterMenuOpen(false);
    }
  }, [libraryBrowseMode]);
  const genreMatches = (track: TrackRecord) =>
    selectedGenreFilter === "all" ||
    normalizeGenreLabels([track.genre])
      .includes(selectedGenreFilter);
  const bookGenreMatches = (track: TrackRecord) =>
    selectedBookGenreFilters.length === 0 ||
    normalizeGenreLabels([track.genre])
      .some((genre) => selectedBookGenreFilters.includes(genre));
  const toggleBookGenreFilter = (genre: string) => {
    setSelectedBookGenreFilters((previous) =>
      previous.includes(genre) ? previous.filter((selected) => selected !== genre) : [...previous, genre]
    );
  };
  const libraryAllTracks = useMemo(() => {
    if (!filteredData || !isLibraryView) {
      return [];
    }

    const filterValue = libraryTrackFilter.trim().toLowerCase();
    const recentTrackIds = new Set(
      [...filteredData.tracks]
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
        .slice(0, 24)
        .map((track) => track.id)
    );

    return filteredData.tracks.filter((track) => {
      const matchesFilter = !filterValue || (track.title ?? "").toLowerCase().includes(filterValue);
      const matchesRecent = !libraryRecentlyAddedOnly || recentTrackIds.has(track.id);
      return matchesFilter && matchesRecent;
    });
  }, [filteredData, isLibraryView, libraryRecentlyAddedOnly, libraryTrackFilter]);
  const libraryTracksFiltered = useMemo(
    () => (filteredData && isLibraryView ? filteredData.tracks.filter(genreMatches) : []),
    [filteredData, isLibraryView, selectedGenreFilter]
  );
  const libraryMusicTracksFiltered = useMemo(() => libraryTracksFiltered.filter((track) => track.mediaKind !== "book"), [libraryTracksFiltered]);
  const libraryBookTracksFiltered = useMemo(
    () => libraryTracksFiltered.filter((track) => track.mediaKind === "book" && bookGenreMatches(track)),
    [libraryTracksFiltered, selectedBookGenreFilters]
  );
  const libraryAlbumGroups = useMemo(() => {
    if (!filteredData || !isLibraryView) {
      return [];
    }

    const albumIds = new Set(libraryMusicTracksFiltered.map((track) => track.albumId));
    return buildAlbumGroups(
      filteredData.albums.filter((album) => albumIds.has(album.id)),
      libraryMusicTracksFiltered
    ).filter((album) => album.tracks.length > 0);
  }, [filteredData, isLibraryView, libraryMusicTracksFiltered]);
  const libraryArtistGroups = useMemo(() => {
    if (!filteredData || !isLibraryView) {
      return [];
    }

    const artistIds = new Set(libraryMusicTracksFiltered.map((track) => getTrackArtistGroupId(track)));
    return buildArtistGroups(
      filteredData.artists.filter((artist) => artistIds.has(artist.id)),
      libraryAlbumGroups
    ).filter((artist) => artist.tracks.length > 0);
  }, [filteredData, isLibraryView, libraryAlbumGroups, libraryMusicTracksFiltered]);
  const libraryBookGroups = useMemo(() => {
    if (!filteredData || !isLibraryView) {
      return [];
    }

    const bookIds = new Set(libraryBookTracksFiltered.map((track) => track.bookId).filter(Boolean));
    return buildBookGroups(
      filteredData.books.filter((book) => bookIds.has(book.id)),
      libraryBookTracksFiltered
    ).filter((book) => book.tracks.length > 0);
  }, [filteredData, isLibraryView, libraryBookTracksFiltered]);
  const sortAuthorGroups = (authors: AuthorWithBooks[]) => {
    if (libraryAuthorsSort === "book-count") {
      return [...authors].sort((left, right) => {
        const countDifference = right.books.length - left.books.length;

        if (countDifference !== 0) {
          return countDifference;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
    }

    return [...authors].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  };
  const sortedAuthorGroups = useMemo(() => sortAuthorGroups(authorGroups), [authorGroups, libraryAuthorsSort]);
  const libraryAuthorGroupsBase = useMemo(() => (isLibraryView ? buildAuthorGroups(libraryBookGroups) : []), [isLibraryView, libraryBookGroups]);
  const filteredLibraryAuthorGroups = useMemo(() => (isLibraryView ? sortAuthorGroups(libraryAuthorGroupsBase) : []), [isLibraryView, libraryAuthorGroupsBase, libraryAuthorsSort]);
  const filteredLibraryBookGroups = useMemo(() => {
    if (!isLibraryView) {
      return [];
    }

    const visibleBooks = libraryBookGroups.filter((book) => {
      const status = getBookCardStatus(book);
      const isCached = isBookCardCached(book);

      if (status === "completed" && !showCompletedBooks) {
        return false;
      }

      if (status === "in-progress" && !showInProgressBooks) {
        return false;
      }

      if (isCached && !showCachedBooks) {
        return false;
      }

      return true;
    });

    if (libraryBooksSort === "length") {
      return [...visibleBooks].sort((left, right) => {
        const durationDifference = (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0);

        if (durationDifference !== 0) {
          return durationDifference;
        }

        return left.title.localeCompare(right.title);
      });
    }

    if (libraryBooksSort === "genre") {
      return [...visibleBooks].sort((left, right) => {
        const leftGenre = getBookCardGenre(left).toLowerCase();
        const rightGenre = getBookCardGenre(right).toLowerCase();

        if (leftGenre !== rightGenre) {
          return leftGenre.localeCompare(rightGenre);
        }

        return left.title.localeCompare(right.title);
      });
    }

    if (libraryBooksSort === "author") {
      return [...visibleBooks].sort((left, right) => {
        const authorDifference = left.author.localeCompare(right.author, undefined, { sensitivity: "base" });

        if (authorDifference !== 0) {
          return authorDifference;
        }

        return left.title.localeCompare(right.title);
      });
    }

    if (libraryBooksSort === "date-added") {
      return [...visibleBooks].sort((left, right) => {
        const dateDifference = getBookCardDateAdded(right).localeCompare(getBookCardDateAdded(left));

        if (dateDifference !== 0) {
          return dateDifference;
        }

        return left.title.localeCompare(right.title);
      });
    }

    if (libraryBooksSort === "year") {
      return [...visibleBooks].sort((left, right) => {
        const yearDifference = (getBookCardYear(right) ?? -1) - (getBookCardYear(left) ?? -1);

        if (yearDifference !== 0) {
          return yearDifference;
        }

        return left.title.localeCompare(right.title);
      });
    }

    if (libraryBooksSort === "status") {
      const statusRank = {
        "in-progress": 0,
        "not-started": 1,
        completed: 2
      } as const;

      return [...visibleBooks].sort((left, right) => {
        const leftStatus = getBookCardStatus(left);
        const rightStatus = getBookCardStatus(right);
        const rankDifference = statusRank[leftStatus] - statusRank[rightStatus];

        if (rankDifference !== 0) {
          return rankDifference;
        }

        return left.title.localeCompare(right.title);
      });
    }

    return visibleBooks;
  }, [isLibraryView, libraryBookGroups, libraryBooksSort, showCachedBooks, showCompletedBooks, showInProgressBooks]);
  const libraryRecentAlbumGroups = useMemo(() => [...libraryAlbumGroups].sort((left, right) => {
    const leftModifiedAt = left.tracks[0]?.modifiedAt ?? "";
    const rightModifiedAt = right.tracks[0]?.modifiedAt ?? "";
    return rightModifiedAt.localeCompare(leftModifiedAt);
  }), [libraryAlbumGroups]);
  const libraryRecentAlbumPreview = useMemo(() => libraryRecentAlbumGroups.slice(0, 4), [libraryRecentAlbumGroups]);
  const recentlyAddedArtists = useMemo(() => [...libraryArtistGroups].sort((left, right) => {
    const leftModifiedAt = [...left.tracks].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0]?.modifiedAt ?? "";
    const rightModifiedAt = [...right.tracks].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0]?.modifiedAt ?? "";
    return rightModifiedAt.localeCompare(leftModifiedAt);
  }), [libraryArtistGroups]);
  const recentlyAddedTracks = useMemo(() => [...libraryTracksFiltered].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, 40), [libraryTracksFiltered]);
  const libraryUserPlaylists = useMemo(() => userPlaylists
    .map((playlist) => ({
      ...playlist,
      tracks: playlist.tracks.filter(genreMatches)
    }))
    .filter((playlist) => playlist.tracks.length > 0), [userPlaylists, selectedGenreFilter, filteredData]);
  const librarySmartPlaylists = useMemo(() => playlists
    .map((playlist) => ({
      ...playlist,
      tracks: playlist.tracks.filter(genreMatches)
    }))
    .filter((playlist) => playlist.tracks.length > 0), [playlists, selectedGenreFilter, filteredData]);
  const playlistDetailRecords = useMemo<PlaylistDetailRecord[]>(() => {
    const personalPlaylists = userPlaylists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: "A personal playlist built from your saved track selections.",
      tracks: sortTracksByPlaybackOrder(playlist.tracks),
      coverArtId: pickStablePlaylistCoverArt(playlist.id, playlist.tracks),
      accent: "warm" as const,
      kind: "personal" as const,
      metaLabel: "Personal playlist"
    }));
    const smartPlaylists = playlists.map((playlist) => ({
      ...playlist,
      description: playlist.description ?? "A server-managed smart playlist.",
      tracks: sortTracksByPlaybackOrder(playlist.tracks),
      coverArtId: pickStablePlaylistCoverArt(playlist.id, playlist.tracks),
      accent: playlist.accent ?? "cool",
      kind: "smart" as const,
      metaLabel: "Smart playlist"
    }));

    return [...personalPlaylists, ...smartPlaylists];
  }, [playlists, userPlaylists]);
  const activePlaylist = playlistDetailRecords.find((playlist) => playlist.id === selectedPlaylistId) ?? null;

  const openAlbum = (albumId: string) => {
    updateRoute({
      view: "album",
      selectedAlbumId: albumId,
      showMobileMenu: false
    });
  };

  const openArtist = (artistId: string) => {
    updateRoute({
      view: "artist",
      selectedArtistId: artistId,
      showMobileMenu: false
    });
  };

  const openAuthor = (authorId: string) => {
    updateRoute({
      view: "author",
      selectedAuthorId: authorId,
      showMobileMenu: false
    });
    requestAnimationFrame(() => {
      scrollPageToTop();
    });
  };

  const openPlaylist = (playlistId: string) => {
    updateRoute({
      view: "playlist",
      selectedPlaylistId: playlistId,
      showMobileMenu: false
    });
  };

  const openBook = (bookId: string) => {
    updateRoute({
      view: "book",
      selectedBookId: bookId,
      showMobileMenu: false
    });
  };

  const openCurrentTrackAlbum = () => {
    if (currentTrack?.mediaKind === "book" && currentTrack.bookId) {
      openBook(currentTrack.bookId);
      return;
    }

    if (currentTrack?.albumId) {
      openAlbum(currentTrack.albumId);
    }
  };

  const openCurrentTrackArtist = () => {
    const artistId = currentTrack ? getTrackArtistGroupId(currentTrack) : null;

    if (artistId) {
      openArtist(artistId);
    }
  };

  const loadSelectedAlbumDetail = async (albumId: string) => {
    setAlbumDetailLoading(true);

    try {
      const detail = await fetchAlbumDetail(albumId);
      setSelectedAlbumDetail({
        ...detail,
        tracks: sortTracksByPlaybackOrder(detail.tracks)
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load album detail");
    } finally {
      setAlbumDetailLoading(false);
    }
  };

  const loadSelectedBookDetail = async (bookId: string) => {
    setBookDetailLoading(true);

    try {
      const detail = await fetchBookDetail(bookId);
      setSelectedBookDetail({
        ...detail,
        tracks: sortTracksByPlaybackOrder(detail.tracks)
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load book detail");
    } finally {
      setBookDetailLoading(false);
    }
  };

  const loadSelectedAlbumDetailUntilArtworkUpdates = async (albumId: string, previousCoverArtId: string | null) => {
    const maxAttempts = 8;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const detail = await fetchAlbumDetail(albumId);
      setSelectedAlbumDetail({
        ...detail,
        tracks: sortTracksByPlaybackOrder(detail.tracks)
      });

      if (detail.album.coverArtId !== previousCoverArtId || attempt === maxAttempts - 1) {
        return detail;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    return null;
  };

  const refreshUserCollections = async () => {
    const [likes, playlists, recent] = await Promise.all([fetchLikedTrackIds(), fetchPlaylists(), fetchRecentlyPlayed()]);
    setLikedTrackIds(new Set(likes.trackIds));
    setUserPlaylists(playlists);
    setRecentlyPlayed(recent);
  };

  const refreshCurrentDetailView = async () => {
    if (view === "album" && selectedAlbumId) {
      await loadSelectedAlbumDetail(selectedAlbumId);
      return;
    }

    if (view === "book" && selectedBookId) {
      await loadSelectedBookDetail(selectedBookId);
    }
  };

  const openAlbumTagsEditor = () => {
    if (!activeAlbum) {
      return;
    }

    const firstTrack = activeAlbumTracks[0];
    setAlbumTagsError(null);
    setAlbumTagsEditorState({
      albumId: activeAlbum.id,
      albumName: activeAlbum.name,
      values: {
        artist: firstTrack?.artist ?? "",
        albumArtist: firstTrack?.albumArtist ?? activeAlbum.artist ?? "",
        album: firstTrack?.album ?? activeAlbum.name,
        year: String(selectedAlbumDetail?.year ?? firstTrack?.year ?? ""),
        genre: selectedAlbumDetail?.genre ?? firstTrack?.genre ?? ""
      }
    });
  };

  const openTrackTagsEditor = (track: TrackRecord) => {
    setTrackTagsError(null);
    setTrackTagsEditorState({
      trackId: track.id,
      contextLabel: track.title ?? track.album ?? "Track",
      values: {
        title: track.title ?? "",
        trackNumber: String(track.trackNumber ?? ""),
        discNumber: String(track.discNumber ?? "")
      }
    });
  };

  const persistBookProgress = async (
    track: TrackRecord | null,
    positionSeconds: number,
    durationHint?: number | null,
    options?: { keepalive?: boolean }
  ) => {
    if (!track?.bookId) {
      return;
    }

    const normalizedPosition = Math.max(0, Math.floor(positionSeconds));
    const totalDuration = durationHint ?? track.durationSeconds ?? 0;
    const shouldClear = totalDuration > 0 && normalizedPosition >= Math.max(totalDuration - 15, 1);
    const saveKey = `${track.bookId}:${track.id}:${shouldClear ? 0 : normalizedPosition}`;

    if (progressSaveRef.current === saveKey) {
      return;
    }

    progressSaveRef.current = saveKey;

    try {
      await saveBookProgress(track.bookId, {
        trackId: track.id,
        positionSeconds: shouldClear ? 0 : normalizedPosition
      }, options);

      if (selectedBookId === track.bookId) {
        await loadSelectedBookDetail(track.bookId);
      }

      setData((previous) =>
        previous
          ? {
              ...previous,
              books: previous.books.map((book) =>
                book.id !== track.bookId
                  ? book
                  : {
                      ...book,
                      lastTrackId: shouldClear ? null : track.id,
                      lastPositionSeconds: shouldClear ? null : normalizedPosition,
                      lastListenedAt: shouldClear ? null : new Date().toISOString()
                    }
              )
            }
          : previous
      );
    } catch {
      progressSaveRef.current = "";
    }
  };

  const waitForScanToComplete = async (previousCompletedAt: string | null) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bootstrapState = await fetchBootstrap();
      const scan = bootstrapState.scan;

      if (!scan.isScanning && scan.lastCompletedAt !== previousCompletedAt) {
        return scan;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    return null;
  };

  const handleToggleLike = async (track: TrackRecord) => {
    try {
      if (likedTrackIds.has(track.id)) {
        await unlikeTrack(track.id);
      } else {
        await likeTrack(track.id);
      }

      await refreshUserCollections();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update liked songs");
    }
  };

  const updateAlbumIdentifyFilters = (patch: Partial<AlbumIdentifyFilters>) => {
    setAlbumIdentifyState((previous) =>
      previous
        ? {
            ...previous,
            filters: {
              ...previous.filters,
              ...patch
            }
          }
        : previous
    );
  };

  const runDiscogsIdentifySearch = async (albumId: string, filters: AlbumIdentifyFilters, previewOnly: boolean) => {
    const response = await identifyAlbum(albumId, {
      previewOnly,
      filters
    });

    if ("status" in response && response.status === "needs-selection") {
      return response.candidates;
    }

    return null;
  };

  const handleIdentifyAlbum = async () => {
    if (!selectedAlbumId) {
      return;
    }

    setAlbumIdentifyLoading(true);

    try {
      const selectedAlbum = activeAlbum ?? data?.albums.find((album) => album.id === selectedAlbumId) ?? null;
      const identifyFilters = buildIdentifyFilters(
        selectedAlbum?.artist ?? null,
        activeAlbumTracks,
        selectedAlbumDetail?.year ?? null,
        selectedAlbumDetail?.genre ?? null
      );
      const candidates = await runDiscogsIdentifySearch(selectedAlbumId, identifyFilters, true);

      if (candidates) {
        setAlbumIdentifyState({
          albumId: selectedAlbumId,
          albumName: selectedAlbum?.name ?? "Select a release",
          candidates,
          filters: identifyFilters
        });
        return;
      }

      setAlbumIdentifyState(null);
      await Promise.all([loadFullLibrary(), loadSelectedAlbumDetailUntilArtworkUpdates(selectedAlbumId, selectedAlbumDetail?.album.coverArtId ?? activeAlbumGroup?.coverArtId ?? null)]);
      setAlbumArtRefreshToken((previous) => previous + 1);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to identify album");
    } finally {
      setAlbumIdentifyLoading(false);
      setAlbumIdentifyPendingCandidateId(null);
    }
  };

  const handleSelectIdentifyCandidate = async (candidateId: number) => {
    if (!albumIdentifyState) {
      return;
    }

    setAlbumIdentifyLoading(true);
    setAlbumIdentifyPendingCandidateId(candidateId);

    try {
      const previousCoverArtId = selectedAlbumDetail?.album.coverArtId ?? activeAlbumGroup?.coverArtId ?? null;
      const previousScanCompletedAt = bootstrap?.scan.lastCompletedAt ?? null;
      await identifyAlbum(albumIdentifyState.albumId, {
        candidateId
      });
      setAlbumIdentifyState(null);
      await waitForScanToComplete(previousScanCompletedAt);
      await Promise.all([loadFullLibrary(), loadSelectedAlbumDetailUntilArtworkUpdates(albumIdentifyState.albumId, previousCoverArtId)]);
      setAlbumArtRefreshToken((previous) => previous + 1);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to identify album");
    } finally {
      setAlbumIdentifyLoading(false);
      setAlbumIdentifyPendingCandidateId(null);
    }
  };

  const handleSearchIdentifyCandidates = async () => {
    if (!albumIdentifyState) {
      return;
    }

    setAlbumIdentifyLoading(true);

    try {
      const candidates = await runDiscogsIdentifySearch(albumIdentifyState.albumId, albumIdentifyState.filters, true);

      setAlbumIdentifyState((previous) =>
        previous
          ? {
              ...previous,
              candidates: candidates ?? []
            }
          : previous
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to search Discogs");
    } finally {
      setAlbumIdentifyLoading(false);
      setAlbumIdentifyPendingCandidateId(null);
    }
  };

  const handleAddToPlaylist = async (track: TrackRecord) => {
    const existingChoices = userPlaylists.map((playlist, index) => `${index + 1}. ${playlist.name}`).join("\n");
    const selection = window.prompt(
      existingChoices
        ? `Add "${track.title ?? "track"}" to a playlist.\nChoose a number, or type a new playlist name.\n\n${existingChoices}`
        : `Create a playlist for "${track.title ?? "track"}" by typing a new playlist name.`
    );

    if (!selection?.trim()) {
      return;
    }

    try {
      const numericSelection = Number(selection);
      let playlistId: string;

      if (Number.isInteger(numericSelection) && numericSelection >= 1 && numericSelection <= userPlaylists.length) {
        playlistId = userPlaylists[numericSelection - 1]!.id;
      } else {
        const playlist = await createPlaylist(selection.trim());
        playlistId = playlist.id;
      }

      await addTrackToPlaylist(playlistId, track.id);
      await refreshUserCollections();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update playlist");
    }
  };

  const handleUpdateAlbumMediaKind = async (albumId: string, mediaKind: "music" | "book") => {
    try {
      const response = await updateAlbumMediaKind(albumId, mediaKind);
      await loadFullLibrary();

      if (response.mediaKind === "book" && response.bookId) {
        openBook(response.bookId);
        return;
      }

      openAlbum(response.albumId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update media type");
    }
  };

  const handleSaveAlbumTags = async () => {
    if (!albumTagsEditorState) {
      return;
    }

    setAlbumTagsSaving(true);
    setAlbumTagsError(null);

    try {
      const response = await updateAlbumTags(albumTagsEditorState.albumId, albumTagsEditorState.values);
      setSelectedAlbumDetail({
        ...response.detail,
        tracks: sortTracksByPlaybackOrder(response.detail.tracks)
      });
      setAlbumTagsEditorState(null);
      updateRoute({
        view: "album",
        selectedAlbumId: response.albumId
      }, { replace: true });
      await loadFullLibrary();
    } catch (nextError) {
      setAlbumTagsError(nextError instanceof Error ? nextError.message : "Failed to save album tags");
    } finally {
      setAlbumTagsSaving(false);
    }
  };

  const handleSaveTrackTags = async () => {
    if (!trackTagsEditorState) {
      return;
    }

    setTrackTagsSaving(true);
    setTrackTagsError(null);

    try {
      await updateTrackTags(trackTagsEditorState.trackId, trackTagsEditorState.values);
      setTrackTagsEditorState(null);
      await loadFullLibrary();
      await refreshCurrentDetailView();
    } catch (nextError) {
      setTrackTagsError(nextError instanceof Error ? nextError.message : "Failed to save track tags");
    } finally {
      setTrackTagsSaving(false);
    }
  };

  const handleAddNextToQueue = (track: TrackRecord) => {
    setPlayQueue((previous) => {
      if (previous.length === 0) {
        return currentTrack && currentTrack.id !== track.id ? [currentTrack, track] : [track];
      }

      const activeIndex = currentTrack ? previous.findIndex((item) => item.id === currentTrack.id) : -1;

      if (activeIndex < 0) {
        return [track, ...previous];
      }

      const nextQueue = [...previous];
      nextQueue.splice(activeIndex + 1, 0, track);
      return nextQueue;
    });
    setQueueLabel("Current Queue");

    if (!currentTrack) {
      setCurrentTrack(track);
    }
  };

  const handleAddLastToQueue = (track: TrackRecord) => {
    setPlayQueue((previous) => {
      if (previous.length === 0) {
        return currentTrack && currentTrack.id !== track.id ? [currentTrack, track] : [track];
      }

      return [...previous, track];
    });
    setQueueLabel("Current Queue");

    if (!currentTrack) {
      setCurrentTrack(track);
    }
  };

  const handleAddSelectionToQueueEnd = async (tracks: TrackRecord[], label: string) => {
    if (tracks.length === 0) {
      return;
    }

    if (!currentTrack || playQueue.length === 0) {
      await playTracks(tracks, label);
      return;
    }

    setPlayQueue((previous) => [...previous, ...tracks]);
    setQueueLabel((previous) => (previous === "No queue" ? label : previous));
  };

  const clearCurrentQueue = (confirmFirst = true) => {
    if (confirmFirst && playQueue.length > 0 && !window.confirm("Clear the current play queue?")) {
      return false;
    }

    setPlayQueue([]);
    setQueueLabel("No queue");
    return true;
  };

  const playTracksFromPosition = async (tracks: TrackRecord[], label: string, trackId: string, positionSeconds: number) => {
    const targetIndex = tracks.findIndex((track) => track.id === trackId);

    if (targetIndex < 0) {
      await playTracks(tracks, label, 0, { forceQueueSelection: true });
      return;
    }

    pendingSeekRef.current = Math.max(0, Math.floor(positionSeconds));
    await playTracks(tracks, label, targetIndex, { forceQueueSelection: true });
  };

  const restartBookFromBeginning = async (bookId: string, title: string, tracks: TrackRecord[]) => {
    const orderedTracks = sortTracksByPlaybackOrder(tracks);
    const firstTrack = orderedTracks[0];

    if (!firstTrack) {
      return;
    }

    const confirmed = window.confirm("Restart this book from the beginning and clear the saved bookmark?");

    if (!confirmed) {
      return;
    }

    const updatedAt = new Date().toISOString();

    try {
      await saveBookProgress(bookId, {
        trackId: firstTrack.id,
        positionSeconds: 0
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not reset the saved bookmark");
    }

    setSelectedBookDetail((previous) =>
      previous && previous.book.id === bookId
        ? {
            ...previous,
            progress: {
              bookId,
              trackId: firstTrack.id,
              positionSeconds: 0,
              updatedAt
            }
          }
        : previous
    );
    setData((previous) =>
      previous
        ? {
            ...previous,
            books: previous.books.map((book) =>
              book.id !== bookId
                ? book
                : {
                    ...book,
                    lastTrackId: firstTrack.id,
                    lastPositionSeconds: 0,
                    lastListenedAt: updatedAt
                  }
            )
          }
        : previous
    );

    await playTracks(orderedTracks, title, 0, { forceQueueSelection: true });
  };

  const markBookAsRead = async (bookId: string, tracks: TrackRecord[]) => {
    const orderedTracks = sortTracksByPlaybackOrder(tracks);
    const lastTrack = orderedTracks[orderedTracks.length - 1];

    if (!lastTrack) {
      return;
    }

    const updatedAt = new Date().toISOString();
    const completedProgress = {
      bookId,
      trackId: lastTrack.id,
      positionSeconds: Math.max(0, lastTrack.durationSeconds ?? 0),
      updatedAt
    };

    try {
      const response = await saveBookProgress(bookId, {
        trackId: completedProgress.trackId,
        positionSeconds: completedProgress.positionSeconds
      });

      setSelectedBookDetail((previous) =>
        previous && previous.book.id === bookId
          ? {
              ...previous,
              progress: response.progress
                ? response.progress
                : completedProgress
            }
          : previous
      );
      setData((previous) =>
        previous
          ? {
              ...previous,
              books: previous.books.map((book) =>
                book.id !== bookId
                  ? book
                  : {
                      ...book,
                      lastTrackId: completedProgress.trackId,
                      lastPositionSeconds: completedProgress.positionSeconds,
                      lastListenedAt: updatedAt
                    }
              )
            }
          : previous
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not mark the book as read");
    }
  };

  const playTracks = async (
    tracks: TrackRecord[],
    label: string,
    startIndex = 0,
    options?: {
      preserveQueue?: boolean;
      skipQueueConfirmation?: boolean;
      forceQueueSelection?: boolean;
    }
  ) => {
    if (tracks.length === 0) {
      return;
    }

    if (currentTrackRef.current?.bookId) {
      const audio = audioRef.current;
      await persistBookProgress(
        currentTrackRef.current,
        Math.floor(audio?.currentTime ?? currentTimeRef.current ?? 0),
        Math.floor(audio?.duration ?? currentTrackRef.current.durationSeconds ?? 0)
      );
    }

    const queueAlbumTracksOnPlay = bootstrap?.settings.queueAlbumTracksOnPlay ?? true;
    const promptBeforeReplacingQueueOnPlay = bootstrap?.settings.promptBeforeReplacingQueueOnPlay ?? true;
    const nextTrack = tracks[startIndex] ?? tracks[0];
    const selectionQueue =
      options?.preserveQueue
        ? tracks
        : options?.forceQueueSelection || queueAlbumTracksOnPlay
          ? tracks.slice(startIndex)
          : [nextTrack];
    const activeAudio = audioRef.current;
    const isSameTrack = currentTrack?.id === nextTrack?.id;

    if (!options?.preserveQueue && !options?.skipQueueConfirmation && playQueue.length > 0) {
      if (promptBeforeReplacingQueueOnPlay) {
        const confirmed = window.confirm("Replace the current queue with this track selection?");

        if (!confirmed) {
          return;
        }
      } else {
        const existingQueue = playQueue.filter((track) => !selectionQueue.some((queuedTrack) => queuedTrack.id === track.id));
        setPlayQueue([...selectionQueue, ...existingQueue]);
        setQueueLabel((previous) => (previous === "No queue" ? label : previous));
        autoplayRequestedRef.current = true;
        setPlaybackError(null);

        if (isSameTrack && activeAudio) {
          try {
            await activeAudio.play();
            autoplayRequestedRef.current = false;
            setPlaybackError(null);
          } catch {
            setPlaybackError("Playback could not start. Check that the track is readable and try again.");
          }
          return;
        }

        setCurrentTrack(nextTrack);
        return;
      }
    }

    autoplayRequestedRef.current = true;
    setPlaybackError(null);
    setPlayQueue(selectionQueue);
    setQueueLabel(label);

    if (isSameTrack && activeAudio) {
      try {
        await activeAudio.play();
        autoplayRequestedRef.current = false;
        setPlaybackError(null);
      } catch {
        setPlaybackError("Playback could not start. Check that the track is readable and try again.");
      }
      return;
    }

    setCurrentTrack(nextTrack);
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    try {
      const session =
        authMode === "register"
          ? await registerFirstUser(authForm)
          : await loginUser({ email: authForm.email, password: authForm.password });

      storeSessionToken(session.token);
      setDismissSetupModal(false);
      const nextBootstrap = await loadBootstrap();

      if (!nextBootstrap.needsLibrarySetup) {
        await loadFullLibrary();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Authentication failed");
    }
  };

  const handleSettingsSave = async (settings: AppSettings) => {
    setSavingSettings(true);
    setError(null);
    const isSetupFlow = bootstrap?.needsLibrarySetup ?? false;

    try {
      const response = await updateSettings(settings);
      setDismissSetupModal(true);
      if (isSetupFlow) {
        navigateToView("home");
      }
      setBootstrap((previous) =>
        previous
          ? {
              ...previous,
              settings: normalizeAppSettings(response.settings),
              needsLibrarySetup: false
            }
          : previous
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const openUserSettings = async () => {
    setShowUserSettings(true);
    setGeneratedApiKeyValue(null);
    setApiKeyCopied(false);
    setError(null);

    try {
      const status = await fetchUserApiKeyStatus();
      setApiKeyStatus(status);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load user settings");
    }
  };

  const closeUserSettings = () => {
    setShowUserSettings(false);
    setGeneratedApiKeyValue(null);
    setApiKeyCopied(false);
  };

  const openLibrarySettings = () => {
    navigateToView("settings");
  };

  const openCurrentUserSettings = async () => {
    updateRoute({
      showMobileMenu: false
    }, { replace: true });
    await openUserSettings();
  };

  const handleFolderScan = async (settings: AppSettings, root: string) => {
    if (!root) {
      return;
    }

    setFolderScanBusy(true);
    setError(null);

    try {
      const response = await updateSettings(settings);
      setDismissSetupModal(true);
      setBootstrap((previous) =>
        previous
          ? {
              ...previous,
              settings: normalizeAppSettings(response.settings),
              needsLibrarySetup: false
            }
          : previous
      );
      await requestFolderRescan(root);
      const nextBootstrap = await loadBootstrap();

      if (nextBootstrap.currentUser && !nextBootstrap.needsLibrarySetup) {
        await loadFullLibrary();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start folder scan");
    } finally {
      setFolderScanBusy(false);
    }
  };

  const handleGenerateApiKey = async () => {
    setApiKeyBusy(true);
    setApiKeyCopied(false);
    setError(null);

    try {
      const response = await generateUserApiKey();
      setGeneratedApiKeyValue(response.apiKey);
      setApiKeyStatus(response.status);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to generate API key");
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleRunMobileCoverJobNow = async () => {
    setJobsBusy(true);
    setError(null);

    try {
      const response = await runMobileCoverArtJobNow();
      setBootstrap((previous) =>
        previous
          ? {
              ...previous,
              jobs: response.jobs
            }
          : previous
      );
      const latestJobs = await fetchAppJobs();
      setBootstrap((previous) =>
        previous
          ? {
              ...previous,
              jobs: latestJobs
            }
          : previous
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start mobile cover job");
    } finally {
      setJobsBusy(false);
    }
  };

  const handleDeleteApiKey = async () => {
    if (apiKeyStatus?.hasApiKey && !window.confirm("Delete the current OpenSubsonic API key? Mobile apps using it will stop connecting.")) {
      return;
    }

    setApiKeyBusy(true);
    setError(null);

    try {
      await deleteUserApiKey();
      const status = await fetchUserApiKeyStatus();
      setApiKeyStatus(status);
      setGeneratedApiKeyValue(null);
      setApiKeyCopied(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete API key");
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleUserSettingsSave = async (settings: AppSettings) => {
    setUserSettingsBusy(true);
    setError(null);
    const normalizedSettings = normalizeAppSettings(settings);
    const previousSettings = bootstrap?.settings ?? DEFAULT_APP_SETTINGS;

    setBootstrap((previous) =>
      previous
        ? {
            ...previous,
            settings: normalizedSettings
          }
        : previous
    );

    try {
      const response = await updateSettings(normalizedSettings);
      setBootstrap((previous) =>
        previous
          ? {
              ...previous,
              settings: normalizeAppSettings(response.settings)
            }
          : previous
      );
      return true;
    } catch (nextError) {
      setBootstrap((previous) =>
        previous
          ? {
              ...previous,
              settings: previousSettings
            }
          : previous
      );
      setError(nextError instanceof Error ? nextError.message : "Failed to save playback settings");
      return false;
    } finally {
      setUserSettingsBusy(false);
    }
  };

  const handleCopyApiKey = async () => {
    if (!generatedApiKeyValue) {
      return;
    }

    await navigator.clipboard.writeText(generatedApiKeyValue);
    setApiKeyCopied(true);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;

    if (!audio || !currentTrack) {
      return;
    }

    if (audio.paused) {
      try {
        await audio.play();
        setPlaybackError(null);
      } catch {
        setPlaybackError("Playback could not start. Check that the track is readable and try again.");
      }
      return;
    }

    audio.pause();
  };

  const effectiveQueue = playQueue.length > 0 ? playQueue : currentTrack ? [currentTrack] : [];
  const currentTrackIndex = currentTrack ? effectiveQueue.findIndex((track) => track.id === currentTrack.id) : -1;
  const queuedTracks = currentTrackIndex >= 0 ? effectiveQueue.slice(currentTrackIndex + 1) : playQueue;
  const remainingSeconds = Math.max(0, durationSeconds - currentTimeSeconds);
  const progressPercent = durationSeconds > 0 ? Math.min(100, (currentTimeSeconds / durationSeconds) * 100) : 0;
  const playPrevious = async () => {
    if (currentTrackIndex > 0) {
      await playTracks(effectiveQueue, queueLabel, currentTrackIndex - 1, { preserveQueue: true, skipQueueConfirmation: true });
    }
  };
  const handleSeek = (nextValue: number) => {
    const audio = audioRef.current;

    if (!audio || !Number.isFinite(nextValue)) {
      return;
    }

    audio.currentTime = nextValue;
    setCurrentTimeSeconds(Math.floor(nextValue));
  };
  const seekCurrentTrackBy = (deltaSeconds: number) => {
    const audio = audioRef.current;

    if (!audio || !currentTrack?.bookId) {
      return;
    }

    const nextValue = Math.max(0, Math.min(durationSeconds || audio.duration || 0, (audio.currentTime || 0) + deltaSeconds));
    audio.currentTime = nextValue;
    setCurrentTimeSeconds(Math.floor(nextValue));
  };
  const playNext = async () => {
    if (currentTrackIndex >= 0 && currentTrackIndex < effectiveQueue.length - 1) {
      await playTracks(effectiveQueue, queueLabel, currentTrackIndex + 1, { preserveQueue: true, skipQueueConfirmation: true });
    }
  };

  const albumHeroMenuEntries: HeroMenuEntry[] = activeAlbum
    ? [
        {
          key: "edit-tags",
          label: "Edit ID3 Tags",
          icon: <FilePenLine className="h-4 w-4" />,
          onSelect: openAlbumTagsEditor
        },
        {
          key: "shuffle",
          label: "Shuffle Album",
          icon: <Shuffle className="h-4 w-4" />,
          onSelect: () => void playTracks(shuffleTracks(activeAlbumTracks), `${activeAlbum.name} Shuffle`)
        },
        {
          key: "up-next",
          label: "Add to Up Next",
          icon: <ListEnd className="h-4 w-4" />,
          onSelect: () => void handleAddSelectionToQueueEnd(activeAlbumTracks, activeAlbum.name)
        }
      ]
    : [];

  const artistHeroMenuEntries: HeroMenuEntry[] = activeArtistGroup
    ? [
        {
          key: "shuffle",
          label: "Shuffle Artist",
          icon: <Shuffle className="h-4 w-4" />,
          onSelect: () => void playTracks(shuffleTracks(activeArtistTracks), `${activeArtistGroup.name} Shuffle`)
        },
        {
          key: "up-next",
          label: "Add to Up Next",
          icon: <ListEnd className="h-4 w-4" />,
          onSelect: () => void handleAddSelectionToQueueEnd(activeArtistTracks, activeArtistGroup.name)
        }
      ]
    : [];

  const authorHeroMenuEntries: HeroMenuEntry[] = activeAuthorGroup
    ? [
        {
          key: "shuffle",
          label: "Shuffle Author",
          icon: <Shuffle className="h-4 w-4" />,
          onSelect: () => void playTracks(shuffleTracks(activeAuthorTracks), `${activeAuthorGroup.name} Shuffle`)
        },
        {
          key: "up-next",
          label: "Add to Up Next",
          icon: <ListEnd className="h-4 w-4" />,
          onSelect: () => void handleAddSelectionToQueueEnd(activeAuthorTracks, activeAuthorGroup.name)
        }
      ]
    : [];

  const playlistHeroMenuEntries: HeroMenuEntry[] = activePlaylist
    ? [
        {
          key: "shuffle",
          label: "Shuffle Playlist",
          icon: <Shuffle className="h-4 w-4" />,
          onSelect: () => void playTracks(shuffleTracks(activePlaylist.tracks), `${activePlaylist.name} Shuffle`)
        },
        {
          key: "up-next",
          label: "Add to Up Next",
          icon: <ListEnd className="h-4 w-4" />,
          onSelect: () => void handleAddSelectionToQueueEnd(activePlaylist.tracks, activePlaylist.name)
        }
      ]
    : [];

  const bookHeroMenuEntries: HeroMenuEntry[] = [];
  if (activeBook) {
    bookHeroMenuEntries.push({
      key: "up-next",
      label: "Add to Up Next",
      icon: <ListEnd className="h-4 w-4" />,
      onSelect: () => void handleAddSelectionToQueueEnd(activeBookTracks, activeBook.title)
    });

    if (activeBookHasResumeProgress && activeBookResumePoint) {
      bookHeroMenuEntries.push({
        key: "extra-status",
        label: "Show synced bookmark position",
        icon: <BookmarkCheck className="h-4 w-4 text-emerald-400" />,
        onSelect: () => {
          const label = buildBookProgressStatusLabel(activeBookResumePoint, activeBookTracks);
          if (label) {
            window.alert(label);
          }
        }
      });
    }

    if (activeBookCompleted) {
      bookHeroMenuEntries.push({
        key: "completed",
        label: "Completed",
        icon: <CircleCheck className="h-4 w-4 text-emerald-400" />,
        disabled: true
      });
    } else {
      bookHeroMenuEntries.push({
        key: "mark-read",
        label: "Mark as Read",
        icon: <CircleCheck className="h-4 w-4" />,
        onSelect: () => void markBookAsRead(activeBook.id, activeBookTracks)
      });
    }

    if (activeBookHasResumeProgress) {
      bookHeroMenuEntries.push({
        key: "restart",
        label: "Restart Book",
        icon: <RotateCcw className="h-4 w-4" />,
        onSelect: () => void restartBookFromBeginning(activeBook.id, activeBook.title, activeBookTracks),
        destructive: true
      });
    }
  }

  const currentUser = bootstrap?.currentUser ?? null;
  const needsAuth = !loading && bootstrap && !currentUser;
  const needsLibrarySetup = !!currentUser && !!bootstrap?.needsLibrarySetup;
  const shouldShowBlockingSetup = !!bootstrap && (needsAuth || (needsLibrarySetup && !dismissSetupModal));
  const scanActive = bootstrap?.scan.isScanning ?? false;
  const showEntityMetadataOnHeroImage = bootstrap?.settings.showEntityMetadataOnHeroImage ?? false;
  const contentReady = view === "settings" ? !!bootstrap : !!filteredData;
  const canRenderShell = !!bootstrap && !needsAuth && !needsLibrarySetup;
  const trackBackedListsLoading = !trackHeavyDataLoaded || trackHeavyDataLoading;
  const showLibraryAlbumSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && (libraryBrowseMode === "all" ? libraryRecentAlbumPreview.length === 0 : libraryAlbumGroups.length === 0);
  const showLibraryArtistSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && libraryArtistGroups.length === 0;
  const showLibraryBookSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && filteredLibraryBookGroups.length === 0;
  const showLibraryAuthorSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && filteredLibraryAuthorGroups.length === 0;
  const showAlbumsPageSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && recentAlbums.length === 0;
  const showArtistsPageSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && artistGroups.length === 0;
  const showBooksPageSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && bookGroups.length === 0;
  const showAuthorsPageSkeleton = (!!bootstrap && (!filteredData || libraryLoading || trackBackedListsLoading)) && sortedAuthorGroups.length === 0;

  useEffect(() => {
    if (loading || libraryLoading || !contentReady) {
      return;
    }

    const pendingMeasure = routeRenderMeasureRef.current;

    if (!pendingMeasure || pendingMeasure.routeKey !== currentRouteKey) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const completedMeasure = routeRenderMeasureRef.current;

      if (!completedMeasure || completedMeasure.routeKey !== currentRouteKey) {
        return;
      }

      appendDebugLog("info", "Route render completed", `${currentRouteKey} | ${Math.round(performance.now() - completedMeasure.startedAt)}ms`);
      routeRenderMeasureRef.current = null;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [contentReady, currentRouteKey, libraryLoading, loading]);

  return (
    <div className="app-shell">
      {shouldShowBlockingSetup ? (
        <div className="modal-scrim">
          <div className="auth-card">
            {needsAuth ? (
              <form className="auth-form" onSubmit={handleAuthSubmit}>
                <div className="modal-copy">
                  <p className="eyebrow">{authMode === "register" ? "First access" : "Welcome back"}</p>
                  <h2>{authMode === "register" ? "Create the first user" : "Sign in"}</h2>
                  <p>
                    {authMode === "register"
                      ? "Set up the initial local account for this installation."
                      : "Use the account created during first-run setup."}
                  </p>
                </div>
                {authMode === "register" ? (
                  <label className="field">
                    <span>Name</span>
                    <input value={authForm.name} onChange={(event) => setAuthForm((previous) => ({ ...previous, name: event.target.value }))} required />
                  </label>
                ) : null}
                <label className="field">
                  <span>Email</span>
                  <input type="email" value={authForm.email} onChange={(event) => setAuthForm((previous) => ({ ...previous, email: event.target.value }))} required />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(event) => setAuthForm((previous) => ({ ...previous, password: event.target.value }))}
                    required
                  />
                </label>
                {error ? <p className="error-banner">{error}</p> : null}
                <button className="cta-button full-width">{authMode === "register" ? "Create account" : "Sign in"}</button>
              </form>
            ) : (
              <SettingsForm
                initialSettings={bootstrap.settings}
                scan={bootstrap.scan}
                jobs={bootstrap.jobs}
                build={bootstrap.build}
                logs={debugLogs}
                busy={savingSettings}
                scanBusy={folderScanBusy}
                jobsBusy={jobsBusy}
                error={error}
                onSubmit={handleSettingsSave}
                onScanLibraryRoot={handleFolderScan}
                onScanBookRoot={handleFolderScan}
                onRunMobileCoverJobNow={handleRunMobileCoverJobNow}
                onClose={() => {
                  setError(null);
                  navigateToView("home");
                }}
                title="Choose your music folder"
                description="Point the app at the root of your MP3 and FLAC collection, then use the scan buttons to build the local index."
                actionLabel="Save settings"
              />
            )}
          </div>
        </div>
      ) : null}

      {showUserSettings && currentUser ? (
        <UserSettingsDialog
          user={currentUser}
          status={apiKeyStatus}
          generatedApiKey={generatedApiKeyValue}
          settings={bootstrap?.settings ?? DEFAULT_APP_SETTINGS}
          busy={apiKeyBusy}
          settingsBusy={userSettingsBusy}
          copied={apiKeyCopied}
          onGenerate={handleGenerateApiKey}
          onDelete={handleDeleteApiKey}
          onCopy={handleCopyApiKey}
          onClose={closeUserSettings}
          onSaveSettings={handleUserSettingsSave}
        />
      ) : null}

      {albumTagsEditorState ? (
        <AlbumTagsDialog
          albumName={albumTagsEditorState.albumName}
          values={albumTagsEditorState.values}
          busy={albumTagsSaving}
          error={albumTagsError}
          onChange={(patch) =>
            setAlbumTagsEditorState((previous) =>
              previous
                ? {
                    ...previous,
                    values: {
                      ...previous.values,
                      ...patch
                    }
                  }
                : previous
            )
          }
          onClose={() => {
            if (!albumTagsSaving) {
              setAlbumTagsEditorState(null);
              setAlbumTagsError(null);
            }
          }}
          onSave={handleSaveAlbumTags}
        />
      ) : null}

      {trackTagsEditorState ? (
        <TrackTagsDialog
          contextLabel={trackTagsEditorState.contextLabel}
          values={trackTagsEditorState.values}
          busy={trackTagsSaving}
          error={trackTagsError}
          onChange={(patch) =>
            setTrackTagsEditorState((previous) =>
              previous
                ? {
                    ...previous,
                    values: {
                      ...previous.values,
                      ...patch
                    }
                  }
                : previous
            )
          }
          onClose={() => {
            if (!trackTagsSaving) {
              setTrackTagsEditorState(null);
              setTrackTagsError(null);
            }
          }}
          onSave={handleSaveTrackTags}
        />
      ) : null}

      {albumIdentifyState ? (
        <AlbumIdentifyDialog
          albumName={albumIdentifyState.albumName}
          filters={albumIdentifyState.filters}
          candidates={albumIdentifyState.candidates}
          busy={albumIdentifyLoading}
          pendingCandidateId={albumIdentifyPendingCandidateId}
          onClose={() => setAlbumIdentifyState(null)}
          onSelect={(candidateId) => handleSelectIdentifyCandidate(candidateId)}
          onSearch={() => handleSearchIdentifyCandidates()}
          onChangeFilters={(patch) => updateAlbumIdentifyFilters(patch)}
        />
      ) : null}

      {showAlbumBioDialog && activeAlbum ? (
        <AlbumBioDialog
          albumName={activeAlbum.name}
          albumArtist={activeAlbum.artist}
          text={activeAlbumBioText}
          onClose={() => setShowAlbumBioDialog(false)}
        />
      ) : null}

      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={groovyBrandIcon} alt="Groovy" />
          <span>Groovy</span>
        </div>

        <nav className="primary-nav">
          {navItems.map((item) => (
            <button key={item.id} className={view === item.id ? "nav-button active" : "nav-button"} onClick={() => navigateToView(item.id)}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-group">
          <p>Library</p>
          <button className={view === "liked" ? "text-button active" : "text-button"} onClick={() => navigateToView("liked")}>
              <Heart className="h-4 w-4" />
            Liked Songs
          </button>
          <button className={view === "recent" ? "text-button active" : "text-button"} onClick={() => navigateToView("recent")}>
              <Clock3 className="h-4 w-4" />
            Recently Played
          </button>
          <button className={view === "playlists" ? "text-button active" : "text-button"} onClick={() => navigateToView("playlists")}>
              <ListMusic className="h-4 w-4" />
            My Playlists
          </button>
          <button className={view === "books" ? "text-button active" : "text-button"} onClick={() => navigateToView("books")}>
              <FileHeadphone className="h-4 w-4" />
            Books
          </button>
          <button className={view === "queue" ? "text-button active" : "text-button"} onClick={() => navigateToView("queue")}>
              <ListVideo className="h-4 w-4" />
            Current Queue
          </button>
          <button className="text-button">
              <UserRoundPlus className="h-4 w-4" />
            Following
          </button>
        </div>

        <div className="sidebar-group">
          <p>Playlists</p>
          {userPlaylists.slice(0, 5).map((playlist) => (
            <button
              key={playlist.id}
              className={view === "playlist" && selectedPlaylistId === playlist.id ? "text-button active" : "text-button"}
              onClick={() => openPlaylist(playlist.id)}
            >
              {playlist.name}
            </button>
          ))}
        </div>

      </aside>

      <main className="main-pane">
        <header className="topbar">
          <div className="topbar-leading">
            {desktopBackLink ? (
              <button className="pill-button ghost back-button topbar-back-link inline-flex items-center gap-2" onClick={() => navigateToView(desktopBackLink.target)}>
                <ArrowLeft className="h-4 w-4" />
                {desktopBackLink.label}
              </button>
            ) : null}
          </div>
          <form
            className="search desktop-search"
            onSubmit={(event) => {
              event.preventDefault();
              submitSearch();
            }}
          >
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search artists, albums, tracks..."
              disabled={!filteredData}
            />
            <button type="submit" className="search-submit-button" disabled={!filteredData} aria-label="Search library">
              <Search className="h-4 w-4" />
            </button>
          </form>
          <div className="topbar-actions">
            <button className="pill-button ghost settings-link flex items-center gap-2" onClick={openLibrarySettings}>
              <Settings className="h-4 w-4" />
              Settings
              {scanActive ? <span className="scan-spinner" aria-label="Scanning library" /> : null}
            </button>
            <button className="avatar-button" onClick={() => void openCurrentUserSettings()} aria-label="Open user settings">
              {currentUser?.name.charAt(0).toUpperCase() ?? "?"}
            </button>
          </div>
        </header>

        {showMobileMenu ? (
          <div className="mobile-overflow-menu">
            <button className="mobile-overflow-item" onClick={() => navigateToView("books")}>
              <div>
                <strong>Books</strong>
                <span>Audiobooks and saved positions</span>
              </div>
              <FileHeadphone className="h-4 w-4" />
            </button>
            <button className="mobile-overflow-item" onClick={() => navigateToView("playlists")}>
              <div>
                <strong>Playlists</strong>
                <span>Your personal and smart mixes</span>
              </div>
              <ListMusic className="h-4 w-4" />
            </button>
            <button className="mobile-overflow-item" onClick={() => navigateToView("recent")}>
              <div>
                <strong>Recently played</strong>
                <span>Jump back into recent listening</span>
              </div>
              <Clock3 className="h-4 w-4" />
            </button>
            <button className="mobile-overflow-item" onClick={openLibrarySettings}>
              <div>
                <strong>Settings</strong>
                <span>Folders, scans, jobs, and build information</span>
              </div>
              <Settings className="h-4 w-4" />
            </button>
            <button className="mobile-overflow-item" onClick={() => void openCurrentUserSettings()}>
              <div>
                <strong>{currentUser?.name ?? "User settings"}</strong>
                <span>{currentUser?.email ?? "Open account and API settings"}</span>
              </div>
              <div className="mobile-overflow-avatar">{currentUser?.name.charAt(0).toUpperCase() ?? "?"}</div>
            </button>
          </div>
        ) : null}

        <nav className="mobile-nav" aria-label="Mobile navigation">
          {mobileNavItems.map((item) => (
            <button
              key={item.id ?? item.label}
              className={(item.action === "menu" ? showMobileMenu : view === item.id) ? "mobile-nav-button active" : "mobile-nav-button"}
              onClick={() => {
                if (item.action === "menu") {
                  updateRoute({
                    showMobileMenu: !showMobileMenu
                  });
                  return;
                }

                navigateToView(item.id as ViewName);
              }}
            >
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {loading || (!contentReady && !needsAuth && !needsLibrarySetup && !canRenderShell) ? (
          <section className="loading-state">{loading ? "Loading application..." : "Loading your indexed library..."}</section>
        ) : null}

        {error && !needsAuth && !needsLibrarySetup ? <p className="error-banner inline">{error}</p> : null}

        {!loading && (contentReady || canRenderShell) ? (
          <div className="content-scroll">
            {view === "settings" && bootstrap ? (
              <section className="settings-page">
                <SettingsForm
                  initialSettings={bootstrap.settings}
                  scan={bootstrap.scan}
                  jobs={bootstrap.jobs}
                  build={bootstrap.build}
                  logs={debugLogs}
                  busy={savingSettings}
                  scanBusy={folderScanBusy}
                  jobsBusy={jobsBusy}
                  error={error}
                  onSubmit={handleSettingsSave}
                  onScanLibraryRoot={handleFolderScan}
                  onScanBookRoot={handleFolderScan}
                  onRunMobileCoverJobNow={handleRunMobileCoverJobNow}
                  onClose={() => navigateToView("home")}
                  title="Settings"
                  description="Manage folders, scan behavior, scheduled jobs, and running build information."
                  actionLabel="Save settings"
                  pageMode
                />
              </section>
            ) : null}

            {view === "home" ? (
              <>
                <section className="hero-card">
                  <div className="hero-copy">
                    <p className="eyebrow">Featured album</p>
                    <p className="hero-meta">
                      {featuredAlbum
                        ? `${featuredAlbum.artist}`
                        : "Point the scanner at your music folders and the home feed will populate automatically."}
                    </p>
                    <h1>{featuredAlbum?.name ?? "Ready to scan your library"}</h1>
                    <p className="hero-text">
                      {featuredAlbum
                        ? "Indexed from your local collection with OpenSubsonic-compatible playback for mobile clients."
                        : "This local server is ready for MP3 and FLAC libraries, responsive indexing, and client integrations."}
                    </p>
                    <div className="hero-actions">
                      <button className="cta-button inline-flex items-center gap-2" onClick={() => (featuredAlbum ? void playTracks(featuredAlbum.tracks, featuredAlbum.name) : undefined)}>
                        <Play className="h-4 w-4" />
                        Play now
                      </button>
                      <button className="pill-button" onClick={() => navigateToView("library")}>
                        View library
                      </button>
                    </div>
                  </div>
                  <div className="hero-art">
                    <AlbumArt coverArtId={featuredAlbum?.coverArtId ?? null} alt={featuredAlbum?.name ?? "Featured album"} />
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>New Releases</h2>
                    <span>{filteredData!.summary.trackCount} indexed tracks</span>
                  </div>
                  <div className="album-grid compact">
                    {recentAlbums.map((album) => (
                      <button key={album.id} className="album-card" onClick={() => openAlbum(album.id)}>
                        <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                          <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                          {showEntityMetadataOnHeroImage ? (
                            <EntityListImageOverlay
                              title={album.name}
                              primaryLine={album.artist}
                              secondaryLine={album.yearLabel}
                            />
                          ) : null}
                        </div>
                        {showEntityMetadataOnHeroImage ? null : (
                          <>
                            <strong>{album.name}</strong>
                            <span>{album.artist} - {album.yearLabel}</span>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {view === "search" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Search</h1>
                    <p>Find artists, albums, books, and tracks from your library.</p>
                  </div>
                </section>

                <section className="content-section search-page-section">
                  <form
                    className="search search-page-input"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitSearch();
                    }}
                  >
                    <input
                      value={searchDraft}
                      onChange={(event) => setSearchDraft(event.target.value)}
                      placeholder="Search artists, albums, books, tracks..."
                      disabled={!filteredData}
                    />
                    <button type="submit" className="search-submit-button" disabled={!filteredData} aria-label="Search library">
                      <Search className="h-4 w-4" />
                    </button>
                  </form>
                </section>

                {query.trim().length === 0 ? (
                  <section className="content-section">
                    <div className="loading-state">Start typing to search your library.</div>
                  </section>
                ) : (
                  <>
                    <section className="content-section">
                      <div className="section-header">
                        <h2>Books</h2>
                        <span>{searchBooks.length} results</span>
                      </div>
                      <div className="album-grid">
                        {searchBooks.map((book) => {
                          const isCompleted = isBookCompleted(getBookCardProgress(book), book.tracks);
                          const isInProgress = isBookInProgress(getBookCardProgress(book), book.tracks);
                          const resumeLabel = isCompleted ? null : getBookCardResumeLabel(book);

                          return (
                            <button key={book.id} className="album-card wide" onClick={() => openBook(book.id)}>
                              <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : "entity-list-art entity-list-art-plain"}>
                                <AlbumArt coverArtId={book.coverArtId} alt={book.title} />
                                {isCompleted ? (
                                  <span className="entity-art-status-badge complete">
                                    <CircleCheck className="h-4 w-4" />
                                    <span>Complete</span>
                                  </span>
                                ) : isInProgress ? (
                                  <span className="entity-art-status-badge progress">
                                    <span>In progress</span>
                                  </span>
                                ) : null}
                                {showEntityMetadataOnHeroImage ? (
                                  <EntityListImageOverlay
                                    title={book.title}
                                    primaryLine={book.author}
                                    secondaryLine={`${book.trackCount} chapters · ${formatDuration(book.durationSeconds)}`}
                                    tertiaryLine={resumeLabel ? `Resume: ${resumeLabel}` : null}
                                  />
                                ) : null}
                              </div>
                              {showEntityMetadataOnHeroImage ? null : (
                                <>
                                  <strong>{book.title}</strong>
                                  <span>{book.author} - {book.trackCount} chapters · {formatDuration(book.durationSeconds)}</span>
                                  {resumeLabel ? <span>Resume: {resumeLabel}</span> : null}
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section className="content-section">
                      <div className="section-header">
                        <h2>Albums</h2>
                        <span>{searchAlbums.length} results</span>
                      </div>
                      <div className="album-grid">
                        {searchAlbums.map((album) => (
                          <button key={album.id} className="album-card wide" onClick={() => openAlbum(album.id)}>
                            <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                              <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={album.name}
                                  primaryLine={album.artist}
                                  secondaryLine={album.yearLabel}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : (
                              <>
                                <strong>{album.name}</strong>
                                <span>{album.artist} - {album.yearLabel}</span>
                              </>
                            )}
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="content-section">
                      <div className="section-header">
                        <h2>Artists</h2>
                        <span>{searchArtists.length} results</span>
                      </div>
                      <div className="artist-page-grid">
                        {searchArtists.map((artist) => (
                          <button
                            key={`${artist.id}:${artist.name}`}
                            className={showEntityMetadataOnHeroImage ? "artist-spotlight-card overlay-enabled" : "artist-spotlight-card"}
                            onClick={() => openArtist(artist.id)}
                          >
                            <div className={showEntityMetadataOnHeroImage ? "artist-spotlight-art entity-list-art" : "artist-spotlight-art entity-list-art entity-list-art-plain"}>
                              <ArtistArt artist={artist.name} coverArtId={getArtistListCoverArtId(artist)} />
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={artist.name}
                                  secondaryLine={`${artist.albums.length} albums`}
                                  tertiaryLine={`${artist.tracks.length} tracks · ${formatDuration(artist.durationSeconds)}`}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : <strong>{artist.name}</strong>}
                            {showEntityMetadataOnHeroImage ? null : <span>{artist.albums.length} albums</span>}
                            {showEntityMetadataOnHeroImage ? null : <span>{artist.tracks.length} tracks · {formatDuration(artist.durationSeconds)}</span>}
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="content-section">
                      <div className="section-header">
                        <h2>Tracks</h2>
                        <span>{searchTracks.length} results</span>
                      </div>
                      <TrackList
                        tracks={searchTracks}
                        currentTrackId={currentTrack?.id ?? null}
                        likedTrackIds={likedTrackIds}
                        isCurrentTrackPlaying={isPlaying}
                        onPlayTrack={(track) => {
                          void playTracks(searchTracks, "Search Results", searchTracks.findIndex((item) => item.id === track.id));
                        }}
                        onEditTags={openTrackTagsEditor}
                        onToggleLike={(track) => {
                          void handleToggleLike(track);
                        }}
                        onAddToPlaylist={(track) => {
                          void handleAddToPlaylist(track);
                        }}
                        onAddNextToQueue={(track) => {
                          handleAddNextToQueue(track);
                        }}
                        onAddLastToQueue={(track) => {
                          handleAddLastToQueue(track);
                        }}
                      />
                    </section>
                  </>
                )}
              </>
            ) : null}

            {view === "library" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Your Library</h1>
                    <p>Everything you have saved, indexed, and ready to stream.</p>
                  </div>
                </section>

                <section className="content-section library-filter-section">
                  <div className="chip-row">
                    {[
                      { id: "all", label: "All" },
                      { id: "albums", label: "Albums" },
                      { id: "artists", label: "Artists" },
                      { id: "books", label: "Books" },
                      { id: "authors", label: "Authors" }
                    ].map((option) => (
                      <button
                        key={option.id}
                        className={libraryBrowseMode === option.id ? "chip chip-primary active" : "chip chip-primary"}
                        onClick={() => {
                          setLibraryBrowseMode(option.id as LibraryBrowseMode);
                          if (option.id === "all" || option.id === "books" || option.id === "authors") {
                            setSelectedGenreFilter("all");
                          }
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {libraryBrowseMode === "albums" || libraryBrowseMode === "artists" ? (
                    <div className="chip-row secondary">
                      <button className={selectedGenreFilter === "all" ? "chip chip-genre active" : "chip chip-genre"} onClick={() => setSelectedGenreFilter("all")}>
                        All Genres
                      </button>
                      {libraryGenres.map((genre) => (
                        <button
                          key={genre}
                          className={selectedGenreFilter === genre ? "chip chip-genre active" : "chip chip-genre"}
                          onClick={() => setSelectedGenreFilter(genre)}
                        >
                          {genre}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>

                {libraryBrowseMode === "all" || libraryBrowseMode === "albums" ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>{libraryBrowseMode === "all" ? "Recently Added" : "Albums"}</h2>
                      {libraryBrowseMode === "all" ? (
                        <button className="link-button" onClick={() => navigateToView("recentlyAdded")}>
                          See All
                        </button>
                      ) : (
                        <span>{libraryAlbumGroups.length} visible</span>
                      )}
                    </div>
                    {showLibraryAlbumSkeleton ? (
                      <GridSkeleton className="album-grid" cardClassName="album-card wide" count={libraryBrowseMode === "all" ? 4 : 8} />
                    ) : (
                      <IncrementalGrid
                        items={libraryBrowseMode === "all" ? libraryRecentAlbumPreview : libraryAlbumGroups}
                        className="album-grid"
                        batchSize={16}
                        initialBatchSize={libraryBrowseMode === "all" ? 8 : 16}
                        itemKey={(album) => album.id}
                        renderItem={(album) => (
                          <button className="album-card wide" onClick={() => openAlbum(album.id)}>
                            <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                              <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={album.name}
                                  primaryLine={album.artist}
                                  secondaryLine={album.yearLabel}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : (
                              <>
                                <strong>{album.name}</strong>
                                <span>{album.artist} - {album.yearLabel}</span>
                              </>
                            )}
                          </button>
                        )}
                      />
                    )}
                  </section>
                ) : null}

                {libraryBrowseMode === "all" ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>All Items</h2>
                      <span>{libraryAllTracks.length} tracks</span>
                    </div>
                    <div className="library-track-filters">
                      <label className="search search-inline">
                        <Search className="h-4 w-4" />
                        <input
                          value={libraryTrackFilter}
                          onChange={(event) => setLibraryTrackFilter(event.target.value)}
                          placeholder="Filter library..."
                        />
                      </label>
                      <button
                        className={libraryRecentlyAddedOnly ? "text-button active library-recent-toggle" : "text-button library-recent-toggle"}
                        onClick={() => setLibraryRecentlyAddedOnly((previous) => !previous)}
                      >
                        <Clock3 className="h-4 w-4" />
                        Recently Added
                      </button>
                    </div>
                    <TrackList
                      tracks={libraryAllTracks}
                      currentTrackId={currentTrack?.id ?? null}
                      likedTrackIds={likedTrackIds}
                      isCurrentTrackPlaying={isPlaying}
                      onPlayTrack={(track) => {
                        void playTracks(libraryAllTracks, "All Tracks", libraryAllTracks.findIndex((item) => item.id === track.id));
                      }}
                      onEditTags={openTrackTagsEditor}
                      onToggleLike={(track) => {
                        void handleToggleLike(track);
                      }}
                      onAddToPlaylist={(track) => {
                        void handleAddToPlaylist(track);
                      }}
                      onAddNextToQueue={(track) => {
                        handleAddNextToQueue(track);
                      }}
                      onAddLastToQueue={(track) => {
                        handleAddLastToQueue(track);
                      }}
                    />
                  </section>
                ) : null}

                {libraryBrowseMode === "artists" ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>Artists</h2>
                      <span>{libraryArtistGroups.length} artists</span>
                    </div>
                    {showLibraryArtistSkeleton ? (
                      <GridSkeleton className="artist-page-grid" cardClassName="artist-spotlight-card" count={8} />
                    ) : (
                      <IncrementalGrid
                        items={libraryArtistGroups}
                        className="artist-page-grid"
                        batchSize={18}
                        initialBatchSize={18}
                        itemKey={(artist) => `${artist.id}:${artist.name}`}
                        renderItem={(artist) => (
                          <button
                            className={showEntityMetadataOnHeroImage ? "artist-spotlight-card overlay-enabled" : "artist-spotlight-card"}
                            onClick={() => openArtist(artist.id)}
                          >
                            <div className={showEntityMetadataOnHeroImage ? "artist-spotlight-art entity-list-art" : "artist-spotlight-art entity-list-art entity-list-art-plain"}>
                              <ArtistArt artist={artist.name} coverArtId={getArtistListCoverArtId(artist)} />
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={artist.name}
                                  secondaryLine={`${artist.albums.length} albums`}
                                  tertiaryLine={`${artist.tracks.length} tracks · ${formatDuration(artist.durationSeconds)}`}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : <strong>{artist.name}</strong>}
                            {showEntityMetadataOnHeroImage ? null : <span>{artist.albums.length} albums</span>}
                            {showEntityMetadataOnHeroImage ? null : <span>{artist.tracks.length} tracks · {formatDuration(artist.durationSeconds)}</span>}
                          </button>
                        )}
                      />
                    )}
                  </section>
                ) : null}

                {libraryBrowseMode === "books" ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>Books</h2>
                      <div className="section-header-actions books-filter-header-actions">
                        <span>{filteredLibraryBookGroups.length} visible</span>
                        <div className="section-filter-menu">
                          {libraryBooksFilterMenuOpen ? (
                            <button
                              type="button"
                              className="entity-hero-menu-backdrop"
                              onClick={() => setLibraryBooksFilterMenuOpen(false)}
                              aria-label="Close books filters"
                            />
                          ) : null}
                          <button
                            type="button"
                            className="pill-button ghost section-filter-trigger inline-flex items-center gap-2"
                            onClick={() => setLibraryBooksFilterMenuOpen((previous) => !previous)}
                            aria-label="Open books filters"
                          >
                            <ListFilter className="h-4 w-4" />
                            <span>Filter</span>
                          </button>
                          {libraryBooksFilterMenuOpen ? (
                            <div className="section-filter-panel">
                              <div className="section-filter-copy">
                                <strong>Book filters</strong>
                                <span>Control which books appear and how they are sorted.</span>
                              </div>
                              <div className="section-filter-group">
                                <strong>Visibility</strong>
                                <label className="toggle-row">
                                  <input
                                    type="checkbox"
                                    checked={showCompletedBooks}
                                    onChange={(event) => setShowCompletedBooks(event.target.checked)}
                                  />
                                  <div className="toggle-copy">
                                    <strong>Completed books</strong>
                                    <span>Show books you have finished.</span>
                                  </div>
                                </label>
                                <label className="toggle-row">
                                  <input
                                    type="checkbox"
                                    checked={showInProgressBooks}
                                    onChange={(event) => setShowInProgressBooks(event.target.checked)}
                                  />
                                  <div className="toggle-copy">
                                    <strong>In progress books</strong>
                                    <span>Show books you have already started.</span>
                                  </div>
                                </label>
                                <label className="toggle-row">
                                  <input
                                    type="checkbox"
                                    checked={showCachedBooks}
                                    onChange={(event) => setShowCachedBooks(event.target.checked)}
                                  />
                                  <div className="toggle-copy">
                                    <strong>Cached books</strong>
                                    <span>Reserved for offline-cached web books. None are currently detected.</span>
                                  </div>
                                </label>
                              </div>
                              <div className="section-filter-group">
                                <strong>Genres</strong>
                                <span>Select one or more genres to include.</span>
                                <div className="section-filter-genre-grid">
                                  {libraryGenres.map((genre) => {
                                    const isSelected = selectedBookGenreFilters.includes(genre);

                                    return (
                                      <button
                                        key={genre}
                                        type="button"
                                        className={isSelected ? "chip chip-genre active section-filter-genre-chip" : "chip chip-genre section-filter-genre-chip"}
                                        onClick={() => toggleBookGenreFilter(genre)}
                                        aria-pressed={isSelected}
                                      >
                                        <span>{genre}</span>
                                        {isSelected ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="section-filter-group">
                                <strong>Sort by</strong>
                                <div className="section-filter-choice-row">
                                  {[
                                    { value: "default", label: "Default" },
                                    { value: "length", label: "Length" },
                                    { value: "genre", label: "Genre" },
                                    { value: "author", label: "Author" },
                                    { value: "date-added", label: "Date Added" },
                                    { value: "year", label: "Year" },
                                    { value: "status", label: "Status" }
                                  ].map((option) => (
                                    <button
                                      key={option.value}
                                      type="button"
                                      className={libraryBooksSort === option.value ? "chip chip-genre active" : "chip chip-genre"}
                                      onClick={() => setLibraryBooksSort(option.value as LibraryBooksSortOption)}
                                    >
                                      {option.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {showLibraryBookSkeleton ? (
                      <GridSkeleton className="album-grid" cardClassName="album-card wide" count={8} metaLines={3} />
                    ) : (
                      <IncrementalGrid
                        items={filteredLibraryBookGroups}
                        className="album-grid"
                        batchSize={18}
                        initialBatchSize={18}
                        itemKey={(book) => book.id}
                        renderItem={(book) => {
                          const isCompleted = isBookCompleted(getBookCardProgress(book), book.tracks);
                          const isInProgress = isBookInProgress(getBookCardProgress(book), book.tracks);
                          const resumeLabel = isCompleted ? null : getBookCardResumeLabel(book);

                          return (
                            <button className="album-card wide" onClick={() => openBook(book.id)}>
                              <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : "entity-list-art entity-list-art-plain"}>
                                <AlbumArt coverArtId={book.coverArtId} alt={book.title} />
                                {isCompleted ? (
                                  <span className="entity-art-status-badge complete">
                                    <CircleCheck className="h-4 w-4" />
                                    <span>Complete</span>
                                  </span>
                                ) : isInProgress ? (
                                  <span className="entity-art-status-badge progress">
                                    <span>In progress</span>
                                  </span>
                                ) : null}
                                {showEntityMetadataOnHeroImage ? (
                                  <EntityListImageOverlay
                                    title={book.title}
                                    primaryLine={book.author}
                                    secondaryLine={`${book.trackCount} chapters · ${formatDuration(book.durationSeconds)}`}
                                    tertiaryLine={resumeLabel ? `Resume: ${resumeLabel}` : null}
                                  />
                                ) : null}
                              </div>
                              {showEntityMetadataOnHeroImage ? null : (
                                <>
                                  <strong>{book.title}</strong>
                                  <span>{book.author} - {book.trackCount} chapters · {formatDuration(book.durationSeconds)}</span>
                                  {resumeLabel ? <span>Resume: {resumeLabel}</span> : null}
                                </>
                              )}
                            </button>
                          );
                        }}
                      />
                    )}
                  </section>
                ) : null}

                {libraryBrowseMode === "authors" ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>Authors</h2>
                      <div className="section-header-actions books-filter-header-actions">
                        <span>{filteredLibraryAuthorGroups.length} visible</span>
                        <div className="section-filter-menu">
                          {libraryAuthorsFilterMenuOpen ? (
                            <button
                              type="button"
                              className="entity-hero-menu-backdrop"
                              onClick={() => setLibraryAuthorsFilterMenuOpen(false)}
                              aria-label="Close author filters"
                            />
                          ) : null}
                          <button
                            type="button"
                            className="pill-button ghost section-filter-trigger inline-flex items-center gap-2"
                            onClick={() => setLibraryAuthorsFilterMenuOpen((previous) => !previous)}
                            aria-label="Open author filters"
                          >
                            <ListFilter className="h-4 w-4" />
                            <span>Filter</span>
                          </button>
                          {libraryAuthorsFilterMenuOpen ? (
                            <div className="section-filter-panel">
                              <div className="section-filter-copy">
                                <strong>Author sorting</strong>
                                <span>Choose how audiobook authors are ordered.</span>
                              </div>
                              <div className="section-filter-group">
                                <strong>Genres</strong>
                                <span>Select one or more genres to include.</span>
                                <div className="section-filter-genre-grid">
                                  {libraryGenres.map((genre) => {
                                    const isSelected = selectedBookGenreFilters.includes(genre);

                                    return (
                                      <button
                                        key={genre}
                                        type="button"
                                        className={isSelected ? "chip chip-genre active section-filter-genre-chip" : "chip chip-genre section-filter-genre-chip"}
                                        onClick={() => toggleBookGenreFilter(genre)}
                                        aria-pressed={isSelected}
                                      >
                                        <span>{genre}</span>
                                        {isSelected ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="section-filter-group">
                                <strong>Sort by</strong>
                                <div className="section-filter-choice-row">
                                  {[
                                    { value: "author", label: "Author" },
                                    { value: "book-count", label: "Book Count" }
                                  ].map((option) => (
                                    <button
                                      key={option.value}
                                      type="button"
                                      className={libraryAuthorsSort === option.value ? "chip chip-genre active" : "chip chip-genre"}
                                      onClick={() => setLibraryAuthorsSort(option.value as LibraryAuthorsSortOption)}
                                    >
                                      {option.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  {showLibraryAuthorSkeleton ? (
                    <GridSkeleton className="artist-page-grid" cardClassName="artist-spotlight-card" count={8} />
                  ) : (
                    <IncrementalGrid
                      items={filteredLibraryAuthorGroups}
                      className="artist-page-grid"
                      batchSize={18}
                      initialBatchSize={18}
                      itemKey={(author) => `${author.id}:${author.name}`}
                      renderItem={(author) => (
                        <button
                          className={showEntityMetadataOnHeroImage ? "artist-spotlight-card overlay-enabled" : "artist-spotlight-card"}
                          onClick={() => openAuthor(author.id)}
                        >
                          <div className={showEntityMetadataOnHeroImage ? "artist-spotlight-art entity-list-art" : "artist-spotlight-art entity-list-art entity-list-art-plain"}>
                            <ArtistArt
                              artist={author.name}
                              coverArtId={getAuthorListCoverArtId(author, filteredData?.summary.lastScanAt ?? null)}
                            />
                            {showEntityMetadataOnHeroImage ? (
                              <EntityListImageOverlay
                                title={author.name}
                                secondaryLine={`${author.books.length} books`}
                                tertiaryLine={`${author.tracks.length} chapters · ${formatDuration(author.durationSeconds)}`}
                              />
                            ) : null}
                          </div>
                          {showEntityMetadataOnHeroImage ? null : <strong>{author.name}</strong>}
                          {showEntityMetadataOnHeroImage ? null : <span>{author.books.length} books</span>}
                          {showEntityMetadataOnHeroImage ? null : <span>{author.tracks.length} chapters · {formatDuration(author.durationSeconds)}</span>}
                        </button>
                      )}
                    />
                  )}
                  </section>
                ) : null}

              </>
            ) : null}

            {view === "recentlyAdded" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Recently Added</h1>
                    <p>The latest albums, artists, and tracks discovered in your library.</p>
                  </div>
                  <button className="pill-button" onClick={() => navigateToView("library")}>Back to Library</button>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Albums</h2>
                    <span>{libraryRecentAlbumGroups.length} items</span>
                  </div>
                  <div className="album-grid">
                    {libraryRecentAlbumGroups.map((album) => (
                      <button key={album.id} className="album-card wide" onClick={() => openAlbum(album.id)}>
                        <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                          <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                          {showEntityMetadataOnHeroImage ? (
                            <EntityListImageOverlay
                              title={album.name}
                              primaryLine={album.artist}
                              secondaryLine={album.yearLabel}
                            />
                          ) : null}
                        </div>
                        {showEntityMetadataOnHeroImage ? null : (
                          <>
                            <strong>{album.name}</strong>
                            <span>{album.artist} - {album.yearLabel}</span>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Artists</h2>
                    <span>{recentlyAddedArtists.length} items</span>
                  </div>
                  <div className="artist-page-grid">
                    {recentlyAddedArtists.map((artist) => (
                      <button
                        key={`${artist.id}:${artist.name}`}
                        className={showEntityMetadataOnHeroImage ? "artist-spotlight-card overlay-enabled" : "artist-spotlight-card"}
                        onClick={() => openArtist(artist.id)}
                      >
                        <div className={showEntityMetadataOnHeroImage ? "artist-spotlight-art entity-list-art" : "artist-spotlight-art entity-list-art entity-list-art-plain"}>
                          <ArtistArt artist={artist.name} coverArtId={getArtistListCoverArtId(artist)} />
                          {showEntityMetadataOnHeroImage ? (
                            <EntityListImageOverlay
                              title={artist.name}
                              secondaryLine={`${artist.albums.length} albums`}
                              tertiaryLine={`${artist.tracks.length} tracks · ${formatDuration(artist.durationSeconds)}`}
                            />
                          ) : null}
                        </div>
                        {showEntityMetadataOnHeroImage ? null : <strong>{artist.name}</strong>}
                        {showEntityMetadataOnHeroImage ? null : <span>{artist.albums.length} albums</span>}
                        {showEntityMetadataOnHeroImage ? null : <span>{artist.tracks.length} tracks · {formatDuration(artist.durationSeconds)}</span>}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Tracks</h2>
                    <span>{recentlyAddedTracks.length} items</span>
                  </div>
                    <TrackList
                      tracks={recentlyAddedTracks}
                      currentTrackId={currentTrack?.id ?? null}
                      likedTrackIds={likedTrackIds}
                      isCurrentTrackPlaying={isPlaying}
                      onPlayTrack={(track) => {
                        void playTracks(recentlyAddedTracks, "Recently Added", recentlyAddedTracks.findIndex((item) => item.id === track.id));
                      }}
                    onEditTags={openTrackTagsEditor}
                    onToggleLike={(track) => {
                      void handleToggleLike(track);
                    }}
                    onAddToPlaylist={(track) => {
                      void handleAddToPlaylist(track);
                    }}
                    onAddNextToQueue={(track) => {
                      handleAddNextToQueue(track);
                    }}
                    onAddLastToQueue={(track) => {
                      handleAddLastToQueue(track);
                    }}
                  />
                </section>
              </>
            ) : null}

            {view === "albums" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Your Albums</h1>
                    <p>{filteredData!.albums.length} albums saved</p>
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Recently Added</h2>
                    <span>{recentAlbums.length} items</span>
                  </div>
                  {showAlbumsPageSkeleton ? (
                    <GridSkeleton className="album-grid" cardClassName="album-card wide" count={8} />
                  ) : (
                    <div className="album-grid">
                      {recentAlbums.map((album) => (
                        <button key={album.id} className="album-card wide" onClick={() => openAlbum(album.id)}>
                          <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                            <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                            {showEntityMetadataOnHeroImage ? (
                              <EntityListImageOverlay
                                title={album.name}
                                primaryLine={album.artist}
                                secondaryLine={album.yearLabel}
                              />
                            ) : null}
                          </div>
                          {showEntityMetadataOnHeroImage ? null : (
                            <>
                              <strong>{album.name}</strong>
                              <span>{album.artist} - {album.yearLabel}</span>
                            </>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Saved Earlier</h2>
                    <span>{savedEarlierAlbums.length} items</span>
                  </div>
                  <div className="album-grid">
                    {savedEarlierAlbums.map((album) => (
                      <button key={album.id} className="album-card wide" onClick={() => openAlbum(album.id)}>
                        <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                          <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                          {showEntityMetadataOnHeroImage ? (
                            <EntityListImageOverlay
                              title={album.name}
                              primaryLine={album.artist}
                              secondaryLine={album.yearLabel}
                            />
                          ) : null}
                        </div>
                        {showEntityMetadataOnHeroImage ? null : (
                          <>
                            <strong>{album.name}</strong>
                            <span>{album.artist} - {album.yearLabel}</span>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {view === "album" ? (
              <>
                <section className="album-detail-hero">
                  <button className="pill-button ghost back-button detail-page-back inline-flex items-center gap-2" onClick={() => navigateToView("albums")}>
                    <ArrowLeft className="h-4 w-4" />
                    Back to albums
                  </button>
                  {activeAlbum ? (
                    <div className="album-detail-card">
                      <div className="album-detail-art">
                        <AlbumArt
                          key={`${activeAlbum.id}:${activeAlbum.coverArtId ?? "none"}:${albumArtRefreshToken}`}
                          coverArtId={activeAlbum.coverArtId}
                          alt={activeAlbum.name}
                          cacheBuster={albumArtRefreshToken}
                        />
                      </div>
                      <div className="album-detail-copy">
                        <div className="album-detail-header">
                          <div className="album-detail-title-copy">
                            <p className="eyebrow">Album</p>
                            <h1>{activeAlbum.name}</h1>
                          </div>
                          <div className="album-detail-header-actions">
                            <button
                              className="footer-icon-button album-action-icon"
                              onClick={() => void handleUpdateAlbumMediaKind(activeAlbum.id, "book")}
                              aria-label="Treat as book"
                              title="Treat as book"
                            >
                              <FileHeadphone className="h-5 w-5" />
                            </button>
                            <button
                              className="footer-icon-button album-identify-button"
                              onClick={() => void handleIdentifyAlbum()}
                              disabled={albumIdentifyLoading}
                              aria-label={albumIdentifyLoading ? "Identifying album on Discogs" : "Identify album on Discogs"}
                              title={albumIdentifyLoading ? "Identifying album on Discogs" : "Identify album on Discogs"}
                            >
                              {albumIdentifyLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <HatGlasses className="h-5 w-5" />}
                            </button>
                            <EntityHeroMenu entityLabel="Album" entries={albumHeroMenuEntries} />
                          </div>
                        </div>
                        <p className="album-detail-meta">
                          {renderDetailMeta([
                            activeAlbum.artist,
                            `${activeAlbum.songCount} tracks`,
                            selectedAlbumDetail?.year ? String(selectedAlbumDetail.year) : null,
                            formatDuration(activeAlbum.durationSeconds)
                          ])}
                        </p>
                        <div className="album-bio-block">
                          <p className="album-detail-text album-bio-text">{albumDetailLoading ? "Loading album details..." : activeAlbumBioText}</p>
                          <button type="button" className="text-link-button album-bio-link" onClick={() => setShowAlbumBioDialog(true)}>
                            Show more
                          </button>
                        </div>
                        <div className="album-detail-actions">
                          <button
                            className="icon-button album-action-button inline-flex items-center gap-2"
                            onClick={() => void playTracks(activeAlbumTracks, activeAlbum.name, 0, { forceQueueSelection: true })}
                          >
                            <Play className="h-4 w-4" />
                            <span>Play Album</span>
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void playTracks(shuffleTracks(activeAlbumTracks), `${activeAlbum.name} Shuffle`)}
                            aria-label="Shuffle album"
                          >
                            <Shuffle className="h-5 w-5" />
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void handleAddSelectionToQueueEnd(activeAlbumTracks, activeAlbum.name)}
                            aria-label="Add album to end of queue"
                          >
                            <ListEnd className="h-5 w-5" />
                          </button>
                          <button className="footer-icon-button album-action-icon" type="button" aria-label="Follow album">
                            <Heart className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="loading-state">Select an album to view its details.</div>
                  )}
                </section>

                {activeAlbum ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>Tracks</h2>
                      <span>Play in album order or one by one</span>
                    </div>
                  <TrackList
                    tracks={activeAlbumTracks}
                    currentTrackId={currentTrack?.id ?? null}
                    likedTrackIds={likedTrackIds}
                    showArtistColumn={false}
                    isCurrentTrackPlaying={isPlaying}
                    onPlayTrack={(_track, index) => {
                      void playTracks(activeAlbumTracks, activeAlbum.name, index);
                    }}
                    onEditTags={openTrackTagsEditor}
                      onToggleLike={(track) => {
                        void handleToggleLike(track);
                      }}
                      onAddToPlaylist={(track) => {
                        void handleAddToPlaylist(track);
                      }}
                      onAddNextToQueue={(track) => {
                        handleAddNextToQueue(track);
                      }}
                      onAddLastToQueue={(track) => {
                        handleAddLastToQueue(track);
                      }}
                    />
                  </section>
                ) : null}
              </>
            ) : null}

            {view === "artist" ? (
              <>
                <section className="album-detail-hero">
                  <button className="pill-button ghost back-button detail-page-back inline-flex items-center gap-2" onClick={() => navigateToView("artists")}>
                    <ArrowLeft className="h-4 w-4" />
                    Back to artists
                  </button>
                  {activeArtistGroup ? (
                    <div className="album-detail-card">
                      <div className="album-detail-art artist-detail-art">
                        <ArtistArt artist={activeArtistGroup.name} coverArtId={activeArtistCoverArtId} />
                      </div>
                      <div className="album-detail-copy">
                        <div className="album-detail-header">
                          <div className="album-detail-title-copy">
                            <p className="eyebrow">Artist</p>
                            <h1>{activeArtistGroup.name}</h1>
                          </div>
                          <div className="album-detail-header-actions">
                            <EntityHeroMenu entityLabel="Artist" entries={artistHeroMenuEntries} />
                          </div>
                        </div>
                        <p className="album-detail-meta">
                          {renderDetailMeta([`${activeArtistAlbums.length} albums`, `${activeArtistTracks.length} tracks`, formatDuration(activeArtistGroup.durationSeconds)])}
                        </p>
                        <p className="album-detail-text">
                          All albums and songs by this artist from your indexed library, laid out in playback order.
                        </p>
                        <div className="album-detail-actions">
                          <button className="icon-button album-action-button inline-flex items-center gap-2" onClick={() => void playTracks(activeArtistTracks, activeArtistGroup.name)}>
                            <Play className="h-4 w-4" />
                            <span>Play Artist</span>
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void playTracks(shuffleTracks(activeArtistTracks), `${activeArtistGroup.name} Shuffle`)}
                            aria-label="Shuffle artist"
                          >
                            <Shuffle className="h-5 w-5" />
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void handleAddSelectionToQueueEnd(activeArtistTracks, activeArtistGroup.name)}
                            aria-label="Add artist to end of queue"
                          >
                            <ListEnd className="h-5 w-5" />
                          </button>
                          <button className="footer-icon-button album-action-icon" type="button" aria-label="Follow artist">
                            <Heart className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="loading-state">Select an artist to view their albums and songs.</div>
                  )}
                </section>

                {activeArtistGroup ? (
                  <>
                    <section className="content-section">
                      <div className="section-header">
                        <h2>Albums</h2>
                        <span>{activeArtistAlbums.length} releases</span>
                      </div>
                      <div className="album-grid">
                        {activeArtistAlbums.map((album) => (
                          <button key={album.id} className="album-card wide" onClick={() => openAlbum(album.id)}>
                            <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                              <AlbumArt coverArtId={album.coverArtId} alt={album.name} />
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={album.name}
                                  primaryLine={album.artist}
                                  secondaryLine={album.yearLabel}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : (
                              <>
                                <strong>{album.name}</strong>
                                <span>{album.artist} - {album.yearLabel}</span>
                              </>
                            )}
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="content-section">
                      <div className="section-header">
                        <h2>Songs</h2>
                        <span>All songs by this artist</span>
                      </div>
                      <TrackList
                        tracks={activeArtistTracks}
                        currentTrackId={currentTrack?.id ?? null}
                        likedTrackIds={likedTrackIds}
                        showArtistColumn={false}
                        isCurrentTrackPlaying={isPlaying}
                        onPlayTrack={(_track, index) => {
                          void playTracks(activeArtistTracks, activeArtistGroup.name, index);
                        }}
                        onEditTags={openTrackTagsEditor}
                        onToggleLike={(track) => {
                          void handleToggleLike(track);
                        }}
                        onAddToPlaylist={(track) => {
                          void handleAddToPlaylist(track);
                        }}
                        onAddNextToQueue={(track) => {
                          handleAddNextToQueue(track);
                        }}
                        onAddLastToQueue={(track) => {
                          handleAddLastToQueue(track);
                        }}
                      />
                    </section>
                  </>
                ) : null}
              </>
            ) : null}

            {view === "playlist" ? (
              <>
                <section className="album-detail-hero">
                  <button className="pill-button ghost back-button detail-page-back inline-flex items-center gap-2" onClick={() => navigateToView("playlists")}>
                    <ArrowLeft className="h-4 w-4" />
                    Back to playlists
                  </button>
                  {activePlaylist ? (
                    <div className="album-detail-card">
                      <div className="album-detail-art">
                        <AlbumArt coverArtId={activePlaylist.coverArtId} alt={activePlaylist.name} />
                      </div>
                      <div className="album-detail-copy">
                        <div className="album-detail-header">
                          <div className="album-detail-title-copy">
                            <p className="eyebrow">{activePlaylist.metaLabel}</p>
                            <h1>{activePlaylist.name}</h1>
                          </div>
                          <div className="album-detail-header-actions">
                            <EntityHeroMenu entityLabel="Playlist" entries={playlistHeroMenuEntries} />
                          </div>
                        </div>
                        <p className="album-detail-meta">
                          {renderDetailMeta([
                            `${activePlaylist.tracks.length} tracks`,
                            formatDuration(activePlaylist.tracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0))
                          ])}
                        </p>
                        <p className="album-detail-text">
                          {activePlaylist.description || "This playlist is ready to play in order or shuffled from the header controls."}
                        </p>
                        <div className="album-detail-actions">
                          <button className="icon-button album-action-button inline-flex items-center gap-2" onClick={() => void playTracks(activePlaylist.tracks, activePlaylist.name)}>
                            <Play className="h-4 w-4" />
                            <span>Play Playlist</span>
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void playTracks(shuffleTracks(activePlaylist.tracks), `${activePlaylist.name} Shuffle`)}
                            aria-label="Shuffle playlist"
                          >
                            <Shuffle className="h-5 w-5" />
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void handleAddSelectionToQueueEnd(activePlaylist.tracks, activePlaylist.name)}
                            aria-label="Add playlist to end of queue"
                          >
                            <ListEnd className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="loading-state">Select a playlist to view its details.</div>
                  )}
                </section>

                {activePlaylist ? (
                  <section className="content-section">
                    <div className="section-header">
                      <h2>Tracks</h2>
                      <span>Play in order, shuffle, or start from any track</span>
                    </div>
                    <TrackList
                      tracks={activePlaylist.tracks}
                      currentTrackId={currentTrack?.id ?? null}
                      likedTrackIds={likedTrackIds}
                      showArtistColumn={false}
                      isCurrentTrackPlaying={isPlaying}
                      onPlayTrack={(_track, index) => {
                        void playTracks(activePlaylist.tracks, activePlaylist.name, index);
                      }}
                      onEditTags={openTrackTagsEditor}
                      onToggleLike={(track) => {
                        void handleToggleLike(track);
                      }}
                      onAddToPlaylist={(track) => {
                        void handleAddToPlaylist(track);
                      }}
                      onAddNextToQueue={(track) => {
                        handleAddNextToQueue(track);
                      }}
                      onAddLastToQueue={(track) => {
                        handleAddLastToQueue(track);
                      }}
                    />
                  </section>
                ) : null}
              </>
            ) : null}

            {view === "liked" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Liked Songs</h1>
                    <p>Your saved favourites.</p>
                  </div>
                </section>
                <section className="content-section">
                  <TrackList
                    tracks={filteredData!.tracks.filter((track) => likedTrackIds.has(track.id))}
                    currentTrackId={currentTrack?.id ?? null}
                    likedTrackIds={likedTrackIds}
                    isCurrentTrackPlaying={isPlaying}
                    onPlayTrack={(track) => {
                      const likedTracks = filteredData!.tracks.filter((item) => likedTrackIds.has(item.id));
                      void playTracks(likedTracks, "Liked Songs", likedTracks.findIndex((item) => item.id === track.id));
                    }}
                    onEditTags={openTrackTagsEditor}
                    onToggleLike={(track) => {
                      void handleToggleLike(track);
                    }}
                    onAddToPlaylist={(track) => {
                      void handleAddToPlaylist(track);
                    }}
                    onAddNextToQueue={(track) => {
                      handleAddNextToQueue(track);
                    }}
                    onAddLastToQueue={(track) => {
                      handleAddLastToQueue(track);
                    }}
                  />
                </section>
              </>
            ) : null}

            {view === "recent" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Recently Played</h1>
                    <p>The latest tracks you have listened to.</p>
                  </div>
                </section>
                <section className="content-section">
                  <TrackList
                    tracks={recentlyPlayed}
                    currentTrackId={currentTrack?.id ?? null}
                    likedTrackIds={likedTrackIds}
                    onPlayTrack={(track, index) => {
                      void playTracks(recentlyPlayed, "Recently Played", index);
                      setCurrentTrack(track);
                    }}
                    onEditTags={openTrackTagsEditor}
                    onToggleLike={(track) => {
                      void handleToggleLike(track);
                    }}
                    onAddToPlaylist={(track) => {
                      void handleAddToPlaylist(track);
                    }}
                    onAddNextToQueue={(track) => {
                      handleAddNextToQueue(track);
                    }}
                    onAddLastToQueue={(track) => {
                      handleAddLastToQueue(track);
                    }}
                  />
                </section>
              </>
            ) : null}

            {view === "queue" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Current Queue</h1>
                    <p>{queuedTracks.length} tracks queued after the current song.</p>
                  </div>
                </section>
                <section className="content-section">
                  <div className="section-header">
                    <h2>{queueLabel === "No queue" ? "Now Playing Queue" : queueLabel}</h2>
                    <div className="section-header-actions">
                      <span>{currentTrack ? `Now playing: ${currentTrack.title ?? "Untitled track"}` : "Queue ready"}</span>
                      <button className="pill-button ghost" onClick={() => clearCurrentQueue(true)} disabled={playQueue.length === 0}>
                        Clear Queue
                      </button>
                    </div>
                  </div>
                  {queuedTracks.length > 0 ? (
                    <>
                      {currentTrack ? (
                        <div className="queue-now-playing-card">
                          <div className="queue-now-playing-art">
                            <AlbumArt coverArtId={currentTrack.coverArtId ?? null} alt={currentTrack.title ?? "Current track"} />
                            <div className="queue-now-playing-glyph-wrap">
                              <NowPlayingGlyph animated={isPlaying} />
                            </div>
                          </div>
                          <div className="queue-now-playing-copy">
                            <p className="eyebrow">Now playing</p>
                            <button type="button" className="text-link-button is-strong" onClick={openCurrentTrackAlbum} disabled={!currentTrack?.albumId}>
                              {currentTrack.title ?? "Untitled track"}
                            </button>
                            <button type="button" className="text-link-button" onClick={openCurrentTrackArtist} disabled={!currentTrack}>
                              {currentTrack?.artist ?? "Unknown artist"}
                            </button>
                            <button type="button" className="text-link-button" onClick={openCurrentTrackAlbum} disabled={!currentTrack?.albumId}>
                              {currentTrack?.album ?? "Unknown album"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <TrackList
                        tracks={queuedTracks}
                        currentTrackId={currentTrack?.id ?? null}
                        likedTrackIds={likedTrackIds}
                        isCurrentTrackPlaying={isPlaying}
                        onPlayTrack={(_track, index) => {
                          const queueStartIndex = currentTrackIndex >= 0 ? currentTrackIndex + 1 : 0;
                          void playTracks(effectiveQueue, queueLabel === "No queue" ? "Current Queue" : queueLabel, queueStartIndex + index, {
                            preserveQueue: true,
                            skipQueueConfirmation: true
                          });
                        }}
                        onEditTags={openTrackTagsEditor}
                        onToggleLike={(track) => {
                          void handleToggleLike(track);
                        }}
                        onAddToPlaylist={(track) => {
                          void handleAddToPlaylist(track);
                        }}
                        onAddNextToQueue={(track) => {
                          handleAddNextToQueue(track);
                        }}
                        onAddLastToQueue={(track) => {
                          handleAddLastToQueue(track);
                        }}
                      />
                    </>
                  ) : (
                    <div className="loading-state">
                      {currentTrack ? "No more songs are queued after the current track." : "Queue is empty. Play an album, playlist, or track to start building the current queue."}
                    </div>
                  )}
                </section>
              </>
            ) : null}

            {view === "artists" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Your Artists</h1>
                    <p>{artistGroups.length} artists with indexed tracks</p>
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Artist Directory</h2>
                    <span>Play an entire artist catalog from one card</span>
                  </div>
                  {showArtistsPageSkeleton ? (
                    <GridSkeleton className="artist-page-grid" cardClassName="artist-spotlight-card" count={8} />
                  ) : (
                    <div className="artist-page-grid">
                      {artistGroups.map((artist) => (
                          <button
                            key={`${artist.id}:${artist.name}`}
                            className={showEntityMetadataOnHeroImage ? "artist-spotlight-card overlay-enabled" : "artist-spotlight-card"}
                            onClick={() => openArtist(artist.id)}
                          >
                            <div className={showEntityMetadataOnHeroImage ? "artist-spotlight-art entity-list-art" : "artist-spotlight-art entity-list-art entity-list-art-plain"}>
                              <ArtistArt artist={artist.name} coverArtId={getArtistListCoverArtId(artist)} />
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={artist.name}
                                  secondaryLine={`${artist.albums.length} albums`}
                                  tertiaryLine={`${artist.tracks.length} tracks · ${formatDuration(artist.durationSeconds)}`}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : <strong>{artist.name}</strong>}
                          {showEntityMetadataOnHeroImage ? null : <span>{artist.albums.length} albums</span>}
                          {showEntityMetadataOnHeroImage ? null : <span>{artist.tracks.length} tracks · {formatDuration(artist.durationSeconds)}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </>
            ) : null}

            {view === "authors" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Your Authors</h1>
                    <p>{sortedAuthorGroups.length} audiobook authors with indexed books</p>
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Author Directory</h2>
                    <div className="section-header-actions books-filter-header-actions">
                      <span>Browse your audiobook library by author</span>
                      <div className="section-filter-menu">
                        {libraryAuthorsFilterMenuOpen ? (
                          <button
                            type="button"
                            className="entity-hero-menu-backdrop"
                            onClick={() => setLibraryAuthorsFilterMenuOpen(false)}
                            aria-label="Close author filters"
                          />
                        ) : null}
                        <button
                          type="button"
                          className="pill-button ghost section-filter-trigger inline-flex items-center gap-2"
                          onClick={() => setLibraryAuthorsFilterMenuOpen((previous) => !previous)}
                          aria-label="Open author filters"
                        >
                          <ListFilter className="h-4 w-4" />
                          <span>Filter</span>
                        </button>
                        {libraryAuthorsFilterMenuOpen ? (
                          <div className="section-filter-panel">
                            <div className="section-filter-copy">
                              <strong>Author sorting</strong>
                              <span>Choose how audiobook authors are ordered.</span>
                            </div>
                            <div className="section-filter-group">
                              <strong>Sort by</strong>
                              <div className="section-filter-choice-row">
                                {[
                                  { value: "author", label: "Author" },
                                  { value: "book-count", label: "Book Count" }
                                ].map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    className={libraryAuthorsSort === option.value ? "chip chip-genre active" : "chip chip-genre"}
                                    onClick={() => setLibraryAuthorsSort(option.value as LibraryAuthorsSortOption)}
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {showAuthorsPageSkeleton ? (
                    <GridSkeleton className="artist-page-grid" cardClassName="artist-spotlight-card" count={8} />
                  ) : (
                    <IncrementalGrid
                      items={sortedAuthorGroups}
                      className="artist-page-grid"
                      batchSize={18}
                      initialBatchSize={18}
                      itemKey={(author) => `${author.id}:${author.name}`}
                      renderItem={(author) => (
                        <button
                          className={showEntityMetadataOnHeroImage ? "artist-spotlight-card overlay-enabled" : "artist-spotlight-card"}
                          onClick={() => openAuthor(author.id)}
                        >
                          <div className={showEntityMetadataOnHeroImage ? "artist-spotlight-art entity-list-art" : "artist-spotlight-art entity-list-art entity-list-art-plain"}>
                            <ArtistArt
                              artist={author.name}
                              coverArtId={getAuthorListCoverArtId(author, filteredData?.summary.lastScanAt ?? null)}
                            />
                            {showEntityMetadataOnHeroImage ? (
                              <EntityListImageOverlay
                                title={author.name}
                                secondaryLine={`${author.books.length} books`}
                                tertiaryLine={`${author.tracks.length} chapters · ${formatDuration(author.durationSeconds)}`}
                              />
                            ) : null}
                          </div>
                          {showEntityMetadataOnHeroImage ? null : <strong>{author.name}</strong>}
                          {showEntityMetadataOnHeroImage ? null : <span>{author.books.length} books</span>}
                          {showEntityMetadataOnHeroImage ? null : <span>{author.tracks.length} chapters · {formatDuration(author.durationSeconds)}</span>}
                        </button>
                      )}
                    />
                  )}
                </section>
              </>
            ) : null}

            {view === "books" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Your Books</h1>
                    <p>{bookGroups.length} books ready for listening and resume.</p>
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Book Shelf</h2>
                    <span>Resume where you left off or start from the beginning</span>
                  </div>
                  {showBooksPageSkeleton ? (
                    <GridSkeleton className="album-grid" cardClassName="album-card wide" count={8} metaLines={3} />
                  ) : (
                    <IncrementalGrid
                      items={bookGroups}
                      className="album-grid"
                      batchSize={18}
                      initialBatchSize={18}
                      itemKey={(book) => book.id}
                      renderItem={(book) => {
                        const isCompleted = isBookCompleted(getBookCardProgress(book), book.tracks);
                        const isInProgress = isBookInProgress(getBookCardProgress(book), book.tracks);
                        const resumeLabel = isCompleted ? null : getBookCardResumeLabel(book);

                        return (
                          <button className="album-card wide" onClick={() => openBook(book.id)}>
                            <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : "entity-list-art entity-list-art-plain"}>
                              <AlbumArt coverArtId={book.coverArtId} alt={book.title} />
                              {isCompleted ? (
                                <span className="entity-art-status-badge complete">
                                  <CircleCheck className="h-4 w-4" />
                                  <span>Complete</span>
                                </span>
                              ) : isInProgress ? (
                                <span className="entity-art-status-badge progress">
                                  <span>In progress</span>
                                </span>
                              ) : null}
                              {showEntityMetadataOnHeroImage ? (
                                <EntityListImageOverlay
                                  title={book.title}
                                  primaryLine={book.author}
                                  secondaryLine={`${book.trackCount} chapters · ${formatDuration(book.durationSeconds)}`}
                                  tertiaryLine={resumeLabel ? `Resume: ${resumeLabel}` : null}
                                />
                              ) : null}
                            </div>
                            {showEntityMetadataOnHeroImage ? null : (
                              <>
                                <strong>{book.title}</strong>
                                <span>{book.author} - {book.trackCount} chapters · {formatDuration(book.durationSeconds)}</span>
                                {resumeLabel ? <span>Resume: {resumeLabel}</span> : null}
                              </>
                            )}
                          </button>
                        );
                      }}
                    />
                  )}
                </section>
              </>
            ) : null}

            {view === "book" ? (
              <>
                <section className="album-detail-hero">
                  <button className="pill-button ghost back-button detail-page-back inline-flex items-center gap-2" onClick={() => navigateToView("books")}>
                    <ArrowLeft className="h-4 w-4" />
                    Back to books
                  </button>
                  {activeBook ? (
                    <div className="album-detail-card">
                      <div className="album-detail-art">
                        <AlbumArt coverArtId={activeBook.coverArtId} alt={activeBook.title} />
                        {activeBookInProgress ? <span className="hero-art-badge">In progress</span> : null}
                      </div>
                      <div className="album-detail-copy">
                        <div className="album-detail-header">
                          <div className="album-detail-title-copy">
                            <p className="eyebrow">Book</p>
                            <h1>{activeBook.title}</h1>
                            <p className="album-detail-meta">
                              {renderDetailMeta([activeBook.author, `${activeBook.trackCount} chapters`, formatDuration(activeBook.durationSeconds)])}
                            </p>
                          </div>
                          <div className="album-detail-header-actions">
                            {activeBookHasResumeProgress && activeBookResumePoint ? (
                              <button
                                className="footer-icon-button album-action-icon"
                                aria-label="Saved resume position"
                                title={formatBookPositionLabel(
                                  activeBookTracks.find((track) => track.id === activeBookResumePoint.trackId),
                                  activeBookResumePoint.positionSeconds
                                ) ?? "Saved resume position"}
                                type="button"
                              >
                                <BookmarkCheck className="h-5 w-5 text-emerald-400" />
                              </button>
                            ) : null}
                            {activeBookCompleted ? (
                              <button className="footer-icon-button album-action-icon" aria-label="Book completed" title="Completed" type="button">
                                <CircleCheck className="h-5 w-5 text-emerald-400" />
                              </button>
                            ) : null}
                            {activeBookTracks[0]?.albumId ? (
                              <button
                                className="footer-icon-button album-action-icon"
                                onClick={() => void handleUpdateAlbumMediaKind(activeBookTracks[0]!.albumId, "music")}
                                aria-label="Treat as album"
                                title="Treat as album"
                              >
                                <Music className="h-5 w-5" />
                              </button>
                            ) : null}
                            <EntityHeroMenu entityLabel="Book" entries={bookHeroMenuEntries} />
                          </div>
                        </div>
                        <p className="album-detail-text">
                          {activeBookHasResumeProgress && activeBookResumePoint
                            ? `Play Book will resume from ${formatBookPositionLabel(activeBookTracks.find((track) => track.id === activeBookResumePoint.trackId), activeBookResumePoint.positionSeconds) ?? "your last position"}.`
                            : "Start from the beginning or jump into any chapter."}
                        </p>
                        <div className="album-detail-actions">
                          <button
                            className="icon-button album-action-button inline-flex items-center gap-2"
                            onClick={() =>
                              activeBookHasResumeProgress && activeBookResumePoint
                                ? void playTracksFromPosition(
                                    activeBookTracks,
                                    `${activeBook.title} Resume`,
                                    activeBookResumePoint.trackId,
                                    activeBookResumePoint.positionSeconds
                                  )
                                : void playTracks(activeBookTracks, activeBook.title)
                            }
                          >
                            <Play className="h-4 w-4" />
                            <span>{activeBookHasResumeProgress ? "Continue" : "Play Book"}</span>
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void handleAddSelectionToQueueEnd(activeBookTracks, activeBook.title)}
                            aria-label="Add book to end of queue"
                          >
                            <ListEnd className="h-5 w-5" />
                          </button>
                          {activeBookHasResumeProgress ? (
                            <button
                              className="footer-icon-button album-action-icon"
                              onClick={() => void restartBookFromBeginning(activeBook.id, activeBook.title, activeBookTracks)}
                              aria-label="Restart book from the beginning"
                              title="Restart from beginning"
                            >
                              <RotateCcw className="h-5 w-5" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="loading-state">Select a book to view its details.</div>
                  )}
                </section>

                {activeBook ? (
                  <>
                    <section className="content-section">
                      <div className="section-header">
                        <h2>Chapters</h2>
                        <span>Play in order or jump to any chapter</span>
                      </div>
                      <TrackList
                        tracks={activeBookTracks}
                        currentTrackId={currentTrack?.id ?? null}
                        likedTrackIds={likedTrackIds}
                        showArtistColumn={false}
                        isCurrentTrackPlaying={isPlaying}
                        onPlayTrack={(_track, index) => {
                          void playTracks(activeBookTracks, activeBook.title, index);
                        }}
                        onEditTags={openTrackTagsEditor}
                        onToggleLike={(track) => {
                          void handleToggleLike(track);
                        }}
                        onAddToPlaylist={(track) => {
                          void handleAddToPlaylist(track);
                        }}
                        onAddNextToQueue={(track) => {
                          handleAddNextToQueue(track);
                        }}
                        onAddLastToQueue={(track) => {
                          handleAddLastToQueue(track);
                        }}
                      />
                    </section>
                  </>
                ) : null}
              </>
            ) : null}

            {view === "author" ? (
              <>
                <section className="album-detail-hero">
                  <button className="pill-button ghost back-button detail-page-back inline-flex items-center gap-2" onClick={() => navigateToView("authors")}>
                    <ArrowLeft className="h-4 w-4" />
                    Back to authors
                  </button>
                  {activeAuthorGroup ? (
                    <div className="album-detail-card">
                      <div className="album-detail-art artist-detail-art">
                        <ArtistArt artist={activeAuthorGroup.name} coverArtId={activeAuthorCoverArtId} />
                      </div>
                      <div className="album-detail-copy">
                        <div className="album-detail-header">
                          <div className="album-detail-title-copy">
                            <p className="eyebrow">Author</p>
                            <h1>{activeAuthorGroup.name}</h1>
                          </div>
                          <div className="album-detail-header-actions">
                            <EntityHeroMenu entityLabel="Author" entries={authorHeroMenuEntries} />
                          </div>
                        </div>
                        <p className="album-detail-meta">
                          {renderDetailMeta([`${activeAuthorBooks.length} books`, `${activeAuthorTracks.length} chapters`, formatDuration(activeAuthorGroup.durationSeconds)])}
                        </p>
                        <p className="album-detail-text">
                          All books and chapters by this author from your audiobook library, laid out in playback order.
                        </p>
                        <div className="album-detail-actions">
                          <button className="icon-button album-action-button inline-flex items-center gap-2" onClick={() => void playTracks(activeAuthorTracks, activeAuthorGroup.name)}>
                            <Play className="h-4 w-4" />
                            <span>Play Author</span>
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void playTracks(shuffleTracks(activeAuthorTracks), `${activeAuthorGroup.name} Shuffle`)}
                            aria-label="Shuffle author"
                          >
                            <Shuffle className="h-5 w-5" />
                          </button>
                          <button
                            className="footer-icon-button album-action-icon"
                            onClick={() => void handleAddSelectionToQueueEnd(activeAuthorTracks, activeAuthorGroup.name)}
                            aria-label="Add author to end of queue"
                          >
                            <ListEnd className="h-5 w-5" />
                          </button>
                          <button className="footer-icon-button album-action-icon" type="button" aria-label="Follow author">
                            <Heart className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="loading-state">Select an author to view their books and chapters.</div>
                  )}
                </section>

                {activeAuthorGroup ? (
                  <>
                    <section className="content-section">
                      <div className="section-header">
                        <h2>Books</h2>
                        <span>{activeAuthorBooks.length} titles</span>
                      </div>
                      <div className="album-grid">
                        {activeAuthorBooks.map((book) => {
                          const isCompleted = isBookCompleted(getBookCardProgress(book), book.tracks);
                          const isInProgress = isBookInProgress(getBookCardProgress(book), book.tracks);
                          const resumeLabel = isCompleted ? null : getBookCardResumeLabel(book);

                          return (
                            <button key={book.id} className="album-card wide" onClick={() => openBook(book.id)}>
                              <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : "entity-list-art entity-list-art-plain"}>
                                <AlbumArt coverArtId={book.coverArtId} alt={book.title} />
                                {isCompleted ? (
                                  <span className="entity-art-status-badge complete">
                                    <CircleCheck className="h-4 w-4" />
                                    <span>Complete</span>
                                  </span>
                                ) : isInProgress ? (
                                  <span className="entity-art-status-badge progress">
                                    <span>In progress</span>
                                  </span>
                                ) : null}
                                {showEntityMetadataOnHeroImage ? (
                                  <EntityListImageOverlay
                                    title={book.title}
                                    primaryLine={book.author}
                                    secondaryLine={`${book.trackCount} chapters · ${formatDuration(book.durationSeconds)}`}
                                    tertiaryLine={resumeLabel ? `Resume: ${resumeLabel}` : null}
                                  />
                                ) : null}
                              </div>
                              {showEntityMetadataOnHeroImage ? null : (
                                <>
                                  <strong>{book.title}</strong>
                                  <span>{book.author} - {book.trackCount} chapters · {formatDuration(book.durationSeconds)}</span>
                                  {resumeLabel ? <span>Resume: {resumeLabel}</span> : null}
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section className="content-section">
                      <div className="section-header">
                        <h2>Chapters</h2>
                        <span>All chapters by this author</span>
                      </div>
                      <TrackList
                        tracks={activeAuthorTracks}
                        currentTrackId={currentTrack?.id ?? null}
                        likedTrackIds={likedTrackIds}
                        showArtistColumn={false}
                        isCurrentTrackPlaying={isPlaying}
                        onPlayTrack={(_track, index) => {
                          void playTracks(activeAuthorTracks, activeAuthorGroup.name, index);
                        }}
                        onEditTags={openTrackTagsEditor}
                        onToggleLike={(track) => {
                          void handleToggleLike(track);
                        }}
                        onAddToPlaylist={(track) => {
                          void handleAddToPlaylist(track);
                        }}
                        onAddNextToQueue={(track) => {
                          handleAddNextToQueue(track);
                        }}
                        onAddLastToQueue={(track) => {
                          handleAddLastToQueue(track);
                        }}
                      />
                    </section>
                  </>
                ) : null}
              </>
            ) : null}

            {view === "playlists" ? (
              <>
                <section className="page-heading">
                  <div>
                    <h1>Your Playlists</h1>
                    <p>{userPlaylists.length} personal playlists and {playlists.length} smart mixes</p>
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Your Playlist Shelf</h2>
                    <span>Created from track actions</span>
                  </div>
                  <div className="playlist-grid">
                    {userPlaylists.map((playlist) => (
                      <button key={playlist.id} className="playlist-card accent-warm" onClick={() => openPlaylist(playlist.id)}>
                        <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                          <AlbumArt coverArtId={pickStablePlaylistCoverArt(playlist.id, playlist.tracks)} alt={playlist.name} />
                          {showEntityMetadataOnHeroImage ? (
                            <EntityListImageOverlay title={playlist.name} secondaryLine={`${playlist.tracks.length} tracks`} />
                          ) : null}
                        </div>
                        {showEntityMetadataOnHeroImage ? null : (
                          <div className="playlist-copy">
                            <strong>{playlist.name}</strong>
                            <span>{playlist.tracks.length} tracks</span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="content-section">
                  <div className="section-header">
                    <h2>Playlist Deck</h2>
                    <span>One-click full playback</span>
                  </div>
                  <div className="playlist-grid">
                    {playlists.map((playlist) => (
                      <button key={playlist.id} className={`playlist-card accent-${playlist.accent ?? "cool"}`} onClick={() => openPlaylist(playlist.id)}>
                        <div className={showEntityMetadataOnHeroImage ? "entity-list-art" : undefined}>
                          <AlbumArt coverArtId={pickStablePlaylistCoverArt(playlist.id, playlist.tracks)} alt={playlist.name} />
                          {showEntityMetadataOnHeroImage ? (
                            <EntityListImageOverlay
                              title={playlist.name}
                              primaryLine={playlist.description}
                              secondaryLine={`${playlist.tracks.length} tracks`}
                            />
                          ) : null}
                        </div>
                        {showEntityMetadataOnHeroImage ? null : (
                          <div className="playlist-copy">
                            <strong>{playlist.name}</strong>
                            <span>{playlist.description}</span>
                            <span>{playlist.tracks.length} tracks</span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </main>

      <footer className="player-bar">
        <div className="now-playing now-playing-left">
          <AlbumArt coverArtId={currentTrack?.coverArtId ?? null} alt={currentTrack?.title ?? "Current track"} />
          <div className="now-playing-meta">
            <div className="now-playing-copy">
              <button type="button" className="text-link-button is-strong" onClick={openCurrentTrackAlbum} disabled={!currentTrack?.albumId}>
                {currentTrack?.title ?? "No track selected"}
              </button>
              <div className="now-playing-subtitle">
                <button type="button" className="text-link-button now-playing-artist-link" onClick={openCurrentTrackArtist} disabled={!currentTrack} title={currentTrackArtist}>
                  <span className="desktop-artist-label">{currentTrackArtist}</span>
                  <span className="mobile-artist-label">{mobileCurrentTrackArtist}</span>
                </button>
                <button
                  type="button"
                  className="text-link-button now-playing-album-link"
                  onClick={openCurrentTrackAlbum}
                  disabled={!currentTrack?.albumId}
                  title={currentTrackAlbum}
                >
                  <span className="desktop-album-label">{currentTrackAlbum}</span>
                  <span className="mobile-album-label">{mobileCurrentTrackAlbum}</span>
                </button>
              </div>
            </div>
            <button
              className={currentTrack && likedTrackIds.has(currentTrack.id) ? "footer-icon-button footer-like-button active" : "footer-icon-button footer-like-button"}
              onClick={() => {
                if (currentTrack) {
                  void handleToggleLike(currentTrack);
                }
              }}
              aria-label={currentTrack && likedTrackIds.has(currentTrack.id) ? "Unlike song" : "Like song"}
              disabled={!currentTrack}
            >
              <Heart className="h-5 w-5" fill={currentTrack && likedTrackIds.has(currentTrack.id) ? "currentColor" : "none"} />
            </button>
          </div>
        </div>

        <div className="player-controls player-controls-stack">
          <div className="player-transport-row">
            <button className="footer-icon-button" aria-label="Shuffle queue">
              <Shuffle className="h-5 w-5" />
            </button>
            <button className="footer-icon-button" onClick={() => void playPrevious()} disabled={currentTrackIndex <= 0} aria-label="Previous track">
              <SkipBack className="h-5 w-5" />
            </button>
            {currentTrack?.bookId ? (
              <button className="footer-icon-button" onClick={() => seekCurrentTrackBy(-20)} aria-label="Back 20 seconds">
                <UndoDot className="h-5 w-5" />
              </button>
            ) : null}
            <button className="player-main-button" onClick={() => void togglePlayback()} disabled={!currentTrack} aria-label={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
            </button>
            {currentTrack?.bookId ? (
              <button className="footer-icon-button" onClick={() => seekCurrentTrackBy(20)} aria-label="Forward 20 seconds">
                <RedoDot className="h-5 w-5" />
              </button>
            ) : null}
            <button
              className="footer-icon-button"
              onClick={() => void playNext()}
              disabled={currentTrackIndex < 0 || currentTrackIndex >= effectiveQueue.length - 1}
              aria-label="Next track"
            >
              <SkipForward className="h-5 w-5" />
            </button>
            <button className="footer-icon-button" aria-label="Repeat queue">
              <Repeat className="h-5 w-5" />
            </button>
          </div>
          <div className="player-progress-row">
            <span>{formatTrackTime(currentTimeSeconds)}</span>
            <label className="player-progress slider-wrap">
              <span className="sr-only">Playback position</span>
              <input
                className="progress-slider"
                type="range"
                min="0"
                max={Math.max(durationSeconds, 1)}
                step="1"
                value={Math.min(currentTimeSeconds, Math.max(durationSeconds, 1))}
                onChange={(event) => handleSeek(Number(event.target.value))}
                aria-label="Playback position"
              />
              <div className="progress-rail">
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </label>
            <span>{formatTrackTime(remainingSeconds)}</span>
          </div>
        </div>

        <div className="player-status now-playing-right">
          <button className="footer-icon-button" onClick={() => currentTrack && void handleAddToPlaylist(currentTrack)} disabled={!currentTrack} aria-label="Add current track to playlist">
            <ListMusic className="h-5 w-5" />
          </button>
          <button className="footer-icon-button" onClick={() => navigateToView("queue")} aria-label="Show current play queue">
            <ListVideo className="h-5 w-5" />
          </button>
          <label className="volume-control">
            <Volume2 className="h-5 w-5" />
            <span className="sr-only">Volume</span>
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="Playback volume"
            />
          </label>
        </div>

        {playbackError ? <div className="error-banner">{playbackError}</div> : null}
        <audio ref={audioRef} preload="none" />
      </footer>
    </div>
  );
};
