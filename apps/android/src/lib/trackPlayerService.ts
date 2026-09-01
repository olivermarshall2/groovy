import TrackPlayer, { Event } from "react-native-track-player";
import {
  invokeTrackPlayerLikeHandler,
  invokeTrackPlayerNextHandler,
  invokeTrackPlayerPreviousHandler,
  recordTrackPlayerRemoteEvent
} from "./trackPlayerAdapter";

const REMOTE_PAUSE_REPLAY_GUARD_MS = 8000;
let ignoreNextRemotePlayUntil = 0;

const register = async () => {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    const now = Date.now();
    if (now < ignoreNextRemotePlayUntil) {
      const remainingMs = ignoreNextRemotePlayUntil - now;
      ignoreNextRemotePlayUntil = 0;
      void recordTrackPlayerRemoteEvent("RemotePlay ignored after RemotePause", {
        action: "pause-replay-guard",
        remainingMs
      });
      return;
    }

    // Transport commands must never wait for diagnostic file I/O.
    void TrackPlayer.play().then(
      () => void recordTrackPlayerRemoteEvent("RemotePlay completed", { action: "resume-existing-queue" }),
      (error) =>
        void recordTrackPlayerRemoteEvent("RemotePlay failed", {
          action: "resume-existing-queue",
          error: error instanceof Error ? error.message : String(error)
        })
    );
    void recordTrackPlayerRemoteEvent("RemotePlay", { action: "resume-existing-queue" });
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    ignoreNextRemotePlayUntil = Date.now() + REMOTE_PAUSE_REPLAY_GUARD_MS;
    // Pause immediately, even if diagnostics storage is slow or unavailable.
    void TrackPlayer.pause().then(
      () => void recordTrackPlayerRemoteEvent("RemotePause completed", { action: "pause-only" }),
      (error) =>
        void recordTrackPlayerRemoteEvent("RemotePause failed", {
          action: "pause-only",
          error: error instanceof Error ? error.message : String(error)
        })
    );
    void recordTrackPlayerRemoteEvent("RemotePause", {
      action: "pause-only",
      replayGuardMs: REMOTE_PAUSE_REPLAY_GUARD_MS
    });
  });

  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    void recordTrackPlayerRemoteEvent("RemoteNext");
    invokeTrackPlayerNextHandler();
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    void recordTrackPlayerRemoteEvent("RemotePrevious");
    invokeTrackPlayerPreviousHandler();
  });

  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    void recordTrackPlayerRemoteEvent("RemoteSeek", {
      position: event.position
    });
    void TrackPlayer.seekTo(event.position);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, (event) => {
    void recordTrackPlayerRemoteEvent("RemoteJumpForward", {
      interval: event.interval
    });
    void TrackPlayer.seekBy(event.interval);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, (event) => {
    void recordTrackPlayerRemoteEvent("RemoteJumpBackward", {
      interval: event.interval
    });
    void TrackPlayer.seekBy(-event.interval);
  });

  TrackPlayer.addEventListener(Event.RemoteLike, () => {
    void recordTrackPlayerRemoteEvent("RemoteLike");
    invokeTrackPlayerLikeHandler();
  });
};

export default register;
