import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  State,
  type PlaybackState,
  type Track,
  type UpdateOptions
} from "react-native-track-player";
import { logError, logInfo } from "./logger";

export type AudioSource = {
  uri?: string;
  headers?: Record<string, string>;
  title?: string;
  artist?: string;
  albumTitle?: string;
  artworkUrl?: string | null;
  duration?: number;
};

export type AudioStatus = {
  playbackState: string;
  timeControlStatus: string;
  playing: boolean;
  didJustFinish: boolean;
  currentTime: number;
  duration: number;
  currentMediaItemIndex?: number;
  currentMediaItemCount?: number;
};

export type LockScreenMetadata = {
  title?: string;
  artist?: string;
  albumTitle?: string;
  artworkUrl?: string | null;
};

export type LockScreenOptions = {
  showPreviousTrack?: boolean;
  showSeekForward?: boolean;
  showSeekBackward?: boolean;
  showNextTrack?: boolean;
  showLikeButton?: boolean;
  isLiked?: boolean;
};

type PlaybackStatusListener = (status: AudioStatus) => void;

type AdapterDiagnostics = {
  setupState: "idle" | "setting-up" | "ready" | "error";
  queueLength: number;
  activeIndex: number | null;
  playbackState: string;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  lockScreenActive: boolean;
  lastCapabilityUpdateAt: string | null;
  lastCapabilitySummary: LockScreenOptions | null;
  lastMetadataTitle: string | null;
  lastMetadataArtist: string | null;
  lastMetadataAlbumTitle: string | null;
  lastMetadataArtworkUrl: string | null;
  lastMetadataArtworkScheme: string | null;
  lastMetadataUpdatedAt: string | null;
  lastRemoteEvent: string | null;
  lastRemoteEventAt: string | null;
  lastError: string | null;
};

type ServiceEventHandlers = {
  onRemoteLike?: (() => void) | null;
  onRemotePrevious?: (() => void) | null;
  onRemoteNext?: (() => void) | null;
};

let setupPromise: Promise<void> | null = null;
let setupState: AdapterDiagnostics["setupState"] = "idle";
let lastError: string | null = null;
let playbackListeners = new Set<PlaybackStatusListener>();
let progressSubscription: { remove(): void } | null = null;
let stateSubscription: { remove(): void } | null = null;
let activeTrackSubscription: { remove(): void } | null = null;
let queueEndedSubscription: { remove(): void } | null = null;
let playWhenReadySubscription: { remove(): void } | null = null;
let errorSubscription: { remove(): void } | null = null;
let serviceHandlers: ServiceEventHandlers = {};
let currentQueue: Track[] = [];
let currentStatus: AudioStatus = {
  playbackState: "idle",
  timeControlStatus: "idle",
  playing: false,
  didJustFinish: false,
  currentTime: 0,
  duration: 0,
  currentMediaItemIndex: undefined,
  currentMediaItemCount: 0
};
let lockScreenActive = false;
let lastCapabilityUpdateAt: string | null = null;
let lastCapabilitySummary: LockScreenOptions | null = null;
let lastMetadataTitle: string | null = null;
let lastMetadataArtist: string | null = null;
let lastMetadataAlbumTitle: string | null = null;
let lastMetadataArtworkUrl: string | null = null;
let lastMetadataArtworkScheme: string | null = null;
let lastMetadataUpdatedAt: string | null = null;
let lastRemoteEvent: string | null = null;
let lastRemoteEventAt: string | null = null;
const PROGRESS_UPDATE_EVENT_INTERVAL_SECONDS = 2;
const ACTIVE_INDEX_SETTLE_TIMEOUT_MS = 1500;
const ACTIVE_INDEX_POLL_INTERVAL_MS = 50;

const getUriScheme = (uri: string | null | undefined) => {
  if (!uri) {
    return null;
  }

  const schemeMatch = uri.match(/^([a-z0-9+.-]+):/i);
  return schemeMatch ? schemeMatch[1].toLowerCase() : "relative";
};

const mapStateToTimeControlStatus = (state: State | string) => {
  if (state === State.Playing) {
    return "playing";
  }

  if (state === State.Buffering || state === State.Loading) {
    return "waiting";
  }

  return "paused";
};

const emitStatus = (patch?: Partial<AudioStatus>) => {
  currentStatus = {
    ...currentStatus,
    ...(patch ?? {})
  };

  playbackListeners.forEach((listener) => {
    try {
      listener(currentStatus);
    } catch {
      //
    }
  });
};

const refreshStatusFromNative = async (patch?: Partial<AudioStatus>) => {
  try {
    const [progress, playbackState, activeIndex] = await Promise.all([
      TrackPlayer.getProgress(),
      TrackPlayer.getPlaybackState(),
      TrackPlayer.getActiveTrackIndex()
    ]);
    emitStatus({
      ...patch,
      playbackState: playbackState.state,
      timeControlStatus: mapStateToTimeControlStatus(playbackState.state),
      playing: playbackState.state === State.Playing,
      currentTime: progress.position,
      duration: progress.duration,
      currentMediaItemIndex: activeIndex,
      currentMediaItemCount: currentQueue.length
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    await logError("Track player status refresh failed", error);
  }
};

const clampQueueIndex = (index: number, queueLength: number) => {
  if (queueLength <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, queueLength - 1));
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const settleActiveTrackIndex = async (expectedIndex: number) => {
  const deadline = Date.now() + ACTIVE_INDEX_SETTLE_TIMEOUT_MS;
  let activeIndex = await TrackPlayer.getActiveTrackIndex();

  while (activeIndex !== expectedIndex && Date.now() < deadline) {
    await sleep(ACTIVE_INDEX_POLL_INTERVAL_MS);
    activeIndex = await TrackPlayer.getActiveTrackIndex();
  }

  return activeIndex;
};

const attachNativeListeners = async () => {
  progressSubscription?.remove();
  stateSubscription?.remove();
  activeTrackSubscription?.remove();
  queueEndedSubscription?.remove();
  playWhenReadySubscription?.remove();
  errorSubscription?.remove();

  progressSubscription = TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, (event) => {
    emitStatus({
      currentTime: event.position,
      duration: event.duration,
      currentMediaItemIndex: event.track,
      currentMediaItemCount: currentQueue.length,
      didJustFinish: false
    });
  });

  stateSubscription = TrackPlayer.addEventListener(Event.PlaybackState, (event) => {
    emitStatus({
      playbackState: event.state,
      timeControlStatus: mapStateToTimeControlStatus(event.state),
      playing: event.state === State.Playing,
      didJustFinish: false
    });
  });

  playWhenReadySubscription = TrackPlayer.addEventListener(Event.PlaybackPlayWhenReadyChanged, (event) => {
    emitStatus({
      playing: event.playWhenReady,
      didJustFinish: false
    });
  });

  activeTrackSubscription = TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (event) => {
    emitStatus({
      currentMediaItemIndex: event.index,
      currentMediaItemCount: currentQueue.length,
      currentTime: 0,
      duration: event.track?.duration ?? currentStatus.duration,
      didJustFinish: false
    });
  });

  queueEndedSubscription = TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async () => {
    await refreshStatusFromNative({ didJustFinish: true });
  });

  errorSubscription = TrackPlayer.addEventListener(Event.PlaybackError, async (event) => {
    lastError = event.message;
    await logError("Track player emitted playback error", null, event);
    await refreshStatusFromNative();
  });
};

const ensurePlayerReady = async () => {
  if (setupPromise) {
    return setupPromise;
  }

  setupState = "setting-up";
  setupPromise = (async () => {
    try {
      await TrackPlayer.setupPlayer({
        minBuffer: 15,
        maxBuffer: 60,
        backBuffer: 15,
        playBuffer: 2.5,
        autoHandleInterruptions: true,
        autoUpdateMetadata: true
      });
      await TrackPlayer.updateOptions({
        progressUpdateEventInterval: PROGRESS_UPDATE_EVENT_INTERVAL_SECONDS,
        capabilities: [Capability.Play, Capability.Pause, Capability.SeekTo],
        compactCapabilities: [Capability.Play, Capability.Pause],
        notificationCapabilities: [Capability.Play, Capability.Pause],
        android: {
          appKilledPlaybackBehavior: AppKilledPlaybackBehavior.PausePlayback,
          alwaysPauseOnInterruption: true
        },
        forwardJumpInterval: 20,
        backwardJumpInterval: 20
      } as UpdateOptions);
      await attachNativeListeners();
      setupState = "ready";
      lastError = null;
      await logInfo("Track player adapter initialized", {
        progressUpdateEventInterval: PROGRESS_UPDATE_EVENT_INTERVAL_SECONDS
      });
      await refreshStatusFromNative();
    } catch (error) {
      setupState = "error";
      lastError = error instanceof Error ? error.message : String(error);
      await logError("Track player setup failed", error);
      throw error;
    }
  })();

  return setupPromise;
};

const toTrack = (source: AudioSource, index: number): Track => ({
  id: `queue-${index}`,
  url: source.uri ?? "",
  title: source.title ?? lastMetadataTitle ?? `Track ${index + 1}`,
  artist: source.artist ?? undefined,
  album: source.albumTitle ?? undefined,
  artwork: source.artworkUrl ?? undefined,
  headers: source.headers,
  duration: source.duration ?? undefined
});

const updateLockScreenOptions = async (options?: LockScreenOptions) => {
  const nextOptions = options ?? {};
  const capabilities: Capability[] = [Capability.Play, Capability.Pause, Capability.SeekTo];
  const compactCapabilities: Capability[] = [Capability.Play, Capability.Pause];

  if (nextOptions.showPreviousTrack) {
    capabilities.push(Capability.SkipToPrevious);
    compactCapabilities.unshift(Capability.SkipToPrevious);
  }

  if (nextOptions.showNextTrack) {
    capabilities.push(Capability.SkipToNext);
    if (compactCapabilities.length < 3) {
      compactCapabilities.push(Capability.SkipToNext);
    }
  }

  if (nextOptions.showSeekBackward) {
    capabilities.push(Capability.JumpBackward);
  }

  if (nextOptions.showSeekForward) {
    capabilities.push(Capability.JumpForward);
  }

  await TrackPlayer.updateOptions({
    capabilities,
    compactCapabilities: compactCapabilities.slice(0, 3),
    notificationCapabilities: capabilities,
    progressUpdateEventInterval: PROGRESS_UPDATE_EVENT_INTERVAL_SECONDS,
    forwardJumpInterval: nextOptions.showSeekForward ? 20 : undefined,
    backwardJumpInterval: nextOptions.showSeekBackward ? 20 : undefined,
    android: {
      appKilledPlaybackBehavior: AppKilledPlaybackBehavior.PausePlayback,
      alwaysPauseOnInterruption: true
    }
  } as UpdateOptions);

  lastCapabilitySummary = nextOptions;
  lastCapabilityUpdateAt = new Date().toISOString();
  await logInfo("Lock screen capabilities updated", {
    options: nextOptions,
    capabilities,
    compactCapabilities: compactCapabilities.slice(0, 3)
  });
};

const updateCurrentTrackMetadata = async (metadata?: LockScreenMetadata | null) => {
  const activeIndex = await TrackPlayer.getActiveTrackIndex();

  if (activeIndex === undefined) {
    await logInfo("Lock screen metadata update skipped because there is no active track index", {
      title: metadata?.title ?? null,
      artist: metadata?.artist ?? null,
      albumTitle: metadata?.albumTitle ?? null,
      artworkUrl: metadata?.artworkUrl ?? null
    });
    return;
  }

  const nextArtworkScheme = getUriScheme(metadata?.artworkUrl);
  const changed =
    lastMetadataTitle !== (metadata?.title ?? null) ||
    lastMetadataArtist !== (metadata?.artist ?? null) ||
    lastMetadataAlbumTitle !== (metadata?.albumTitle ?? null) ||
    lastMetadataArtworkUrl !== (metadata?.artworkUrl ?? null);

  await logInfo("Track player metadata update requested", {
    activeIndex,
    changed,
    previous: {
      title: lastMetadataTitle,
      artist: lastMetadataArtist,
      albumTitle: lastMetadataAlbumTitle,
      artworkUrl: lastMetadataArtworkUrl,
      artworkScheme: lastMetadataArtworkScheme,
      updatedAt: lastMetadataUpdatedAt
    },
    next: {
      title: metadata?.title ?? null,
      artist: metadata?.artist ?? null,
      albumTitle: metadata?.albumTitle ?? null,
      artworkUrl: metadata?.artworkUrl ?? null,
      artworkScheme: nextArtworkScheme
    }
  });

  lastMetadataTitle = metadata?.title ?? null;
  lastMetadataArtist = metadata?.artist ?? null;
  lastMetadataAlbumTitle = metadata?.albumTitle ?? null;
  lastMetadataArtworkUrl = metadata?.artworkUrl ?? null;
  lastMetadataArtworkScheme = nextArtworkScheme;
  lastMetadataUpdatedAt = new Date().toISOString();
  await TrackPlayer.updateMetadataForTrack(activeIndex, {
    title: metadata?.title,
    artist: metadata?.artist,
    album: metadata?.albumTitle,
    artwork: metadata?.artworkUrl ?? undefined
  });

  const persistedTrack = await TrackPlayer.getTrack(activeIndex).catch(() => null);
  await logInfo("Lock screen metadata updated", {
    activeIndex,
    changed,
    title: metadata?.title ?? null,
    artist: metadata?.artist ?? null,
    albumTitle: metadata?.albumTitle ?? null,
    artworkUrl: metadata?.artworkUrl ?? null,
    artworkScheme: nextArtworkScheme,
    persistedTrackTitle: persistedTrack?.title ?? null,
    persistedTrackArtist: persistedTrack?.artist ?? null,
    persistedTrackAlbum: persistedTrack?.album ?? null,
    persistedTrackArtwork: typeof persistedTrack?.artwork === "string" ? persistedTrack.artwork : null,
    persistedTrackArtworkScheme: typeof persistedTrack?.artwork === "string" ? getUriScheme(persistedTrack.artwork) : null
  });
};

export const getTrackPlayerDiagnosticsSnapshot = (): AdapterDiagnostics => ({
  setupState,
  queueLength: currentQueue.length,
  activeIndex: currentStatus.currentMediaItemIndex ?? null,
  playbackState: currentStatus.playbackState,
  playing: currentStatus.playing,
  positionSeconds: currentStatus.currentTime,
  durationSeconds: currentStatus.duration,
  lockScreenActive,
  lastCapabilityUpdateAt,
  lastCapabilitySummary,
  lastMetadataTitle,
  lastMetadataArtist,
  lastMetadataAlbumTitle,
  lastMetadataArtworkUrl,
  lastMetadataArtworkScheme,
  lastMetadataUpdatedAt,
  lastRemoteEvent,
  lastRemoteEventAt,
  lastError
});

export const setTrackPlayerServiceHandlers = (handlers: ServiceEventHandlers) => {
  serviceHandlers = handlers;
};

export const recordTrackPlayerRemoteEvent = async (eventName: string, details?: Record<string, unknown>) => {
  lastRemoteEvent = eventName;
  lastRemoteEventAt = new Date().toISOString();
  await logInfo("Track player remote event", {
    eventName,
    ...(details ?? {})
  });
};

export const invokeTrackPlayerLikeHandler = () => {
  serviceHandlers.onRemoteLike?.();
};

export const invokeTrackPlayerPreviousHandler = () => {
  serviceHandlers.onRemotePrevious?.();
};

export const invokeTrackPlayerNextHandler = () => {
  serviceHandlers.onRemoteNext?.();
};

export const setAudioModeAsync = async (_options: Record<string, unknown>) => {
  await ensurePlayerReady();
};

export type AudioPlayer = {
  playing: boolean;
  currentTime: number;
  duration: number;
  addListener: (eventName: "playbackStatusUpdate", listener: PlaybackStatusListener) => { remove(): void };
  replace: (source: AudioSource) => Promise<void>;
  replaceQueue: (sources: AudioSource[], startIndex: number, startPositionSeconds?: number, playWhenReady?: boolean) => Promise<void>;
  seekToQueueItem: (index: number, startPositionSeconds?: number, playWhenReady?: boolean) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seekTo: (positionSeconds: number) => Promise<void>;
  remove: () => Promise<void>;
  setActiveForLockScreen: (active: boolean, metadata?: LockScreenMetadata, options?: LockScreenOptions) => Promise<void>;
  updateLockScreenMetadata: (metadata: LockScreenMetadata) => Promise<void>;
  clearLockScreenControls: () => Promise<void>;
};

class TrackPlayerBackedAudioPlayer implements AudioPlayer {
  get playing() {
    return currentStatus.playing;
  }

  get currentTime() {
    return currentStatus.currentTime;
  }

  get duration() {
    return currentStatus.duration;
  }

  addListener(_eventName: "playbackStatusUpdate", listener: PlaybackStatusListener) {
    playbackListeners.add(listener);
    listener(currentStatus);
    return {
      remove: () => {
        playbackListeners.delete(listener);
      }
    };
  }

  async replace(source: AudioSource) {
    await ensurePlayerReady();
    currentQueue = [toTrack(source, 0)];
    await TrackPlayer.reset();
    await TrackPlayer.add(currentQueue);
    await refreshStatusFromNative({
      currentMediaItemIndex: 0,
      currentMediaItemCount: 1,
      currentTime: 0,
      didJustFinish: false
    });
  }

  async replaceQueue(sources: AudioSource[], startIndex: number, startPositionSeconds = 0, playWhenReady = true) {
    await ensurePlayerReady();
    currentQueue = sources.map((source, index) => toTrack(source, index));
    const targetIndex = clampQueueIndex(startIndex, currentQueue.length);

    await TrackPlayer.reset();

    if (currentQueue.length === 0) {
      await refreshStatusFromNative({
        currentMediaItemCount: 0,
        currentMediaItemIndex: undefined,
        currentTime: 0,
        duration: 0,
        didJustFinish: false
      });
      return;
    }

    await TrackPlayer.add(currentQueue);
    await TrackPlayer.skip(targetIndex, Math.max(0, startPositionSeconds));
    const settledIndex = await settleActiveTrackIndex(targetIndex);

    if (settledIndex !== targetIndex) {
      await logInfo("Track player active index mismatch after queue replace, retrying skip", {
        expectedIndex: targetIndex,
        actualIndex: settledIndex,
        queueLength: currentQueue.length
      });
      await TrackPlayer.skip(targetIndex, Math.max(0, startPositionSeconds));
    }

    if (playWhenReady) {
      await TrackPlayer.play();
    } else {
      await TrackPlayer.pause();
    }
    await refreshStatusFromNative({
      currentMediaItemCount: currentQueue.length,
      currentMediaItemIndex: targetIndex,
      didJustFinish: false
    });
  }

  async seekToQueueItem(index: number, startPositionSeconds = 0, playWhenReady = true) {
    await ensurePlayerReady();
    const targetIndex = clampQueueIndex(index, currentQueue.length);
    await TrackPlayer.skip(targetIndex, Math.max(0, startPositionSeconds));
    const settledIndex = await settleActiveTrackIndex(targetIndex);

    if (settledIndex !== targetIndex) {
      await logInfo("Track player active index mismatch after seekToQueueItem, retrying skip", {
        expectedIndex: targetIndex,
        actualIndex: settledIndex,
        queueLength: currentQueue.length
      });
      await TrackPlayer.skip(targetIndex, Math.max(0, startPositionSeconds));
    }

    if (playWhenReady) {
      await TrackPlayer.play();
    }
    await refreshStatusFromNative({
      currentMediaItemIndex: targetIndex,
      currentMediaItemCount: currentQueue.length,
      didJustFinish: false
    });
  }

  async play() {
    await ensurePlayerReady();
    await TrackPlayer.play();
    await refreshStatusFromNative({ didJustFinish: false });
  }

  async pause() {
    await ensurePlayerReady();
    await TrackPlayer.pause();
    await refreshStatusFromNative({ didJustFinish: false });
  }

  async seekTo(positionSeconds: number) {
    await ensurePlayerReady();
    await TrackPlayer.seekTo(Math.max(0, positionSeconds));
    await refreshStatusFromNative({
      currentTime: Math.max(0, positionSeconds),
      didJustFinish: false
    });
  }

  async remove() {
    playbackListeners.clear();
  }

  async setActiveForLockScreen(active: boolean, metadata?: LockScreenMetadata, options?: LockScreenOptions) {
    await ensurePlayerReady();
    lockScreenActive = active;
    if (!active) {
      await updateLockScreenOptions({});
      return;
    }
    await updateLockScreenOptions(options);
    if (metadata) {
      await updateCurrentTrackMetadata(metadata);
    }
  }

  async updateLockScreenMetadata(metadata: LockScreenMetadata) {
    await ensurePlayerReady();
    await updateCurrentTrackMetadata(metadata);
  }

  async clearLockScreenControls() {
    lockScreenActive = false;
    await updateLockScreenOptions({});
  }
}

const sharedPlayer = new TrackPlayerBackedAudioPlayer();

export const createAudioPlayer = (_source: null, _options?: { updateInterval?: number }) => sharedPlayer;
