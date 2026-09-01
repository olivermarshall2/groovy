import TrackPlayer, { Event } from "react-native-track-player";
import {
  invokeTrackPlayerLikeHandler,
  invokeTrackPlayerNextHandler,
  invokeTrackPlayerPreviousHandler,
  recordTrackPlayerRemoteEvent
} from "./trackPlayerAdapter";

const register = async () => {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    void (async () => {
      await recordTrackPlayerRemoteEvent("RemotePlay", { action: "resume-existing-queue" });
      await TrackPlayer.play();
      await recordTrackPlayerRemoteEvent("RemotePlay completed", { action: "resume-existing-queue" });
    })();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    void (async () => {
      await recordTrackPlayerRemoteEvent("RemotePause", { action: "pause-only" });
      await TrackPlayer.pause();
      await recordTrackPlayerRemoteEvent("RemotePause completed", { action: "pause-only" });
    })();
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
