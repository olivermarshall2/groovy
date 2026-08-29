package expo.modules.audio.service

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

@OptIn(UnstableApi::class)
class AudioMediaSessionCallback(private val context: Context) : MediaSession.Callback {
  override fun onConnect(
    session: MediaSession,
    controller: MediaSession.ControllerInfo
  ): MediaSession.ConnectionResult {
    try {
      // Configure commands - custom layout buttons will be rendered from session
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailablePlayerCommands(
          MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
            // Keep seek commands for the seek slider
            .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_FORWARD)
            .add(Player.COMMAND_SEEK_BACK)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .add(Player.COMMAND_SEEK_TO_NEXT)
            .build()
        )
        .setAvailableSessionCommands(
          MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
            .add(SessionCommand(AudioControlsService.ACTION_PREVIOUS_TRACK, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_SEEK_BACKWARD, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_SEEK_FORWARD, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_NEXT_TRACK, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_TOGGLE_LIKE, Bundle.EMPTY))
            .build()
        )
        .build()
    } catch (e: Exception) {
      return MediaSession.ConnectionResult.reject()
    }
  }

  override fun onCustomCommand(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    command: SessionCommand,
    args: Bundle
  ): ListenableFuture<SessionResult> {
    when (command.customAction) {
      AudioControlsService.ACTION_PREVIOUS_TRACK -> {
        if (session.player.hasPreviousMediaItem()) {
          session.player.seekToPreviousMediaItem()
        } else {
          session.player.seekTo(0)
        }
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      AudioControlsService.ACTION_SEEK_FORWARD -> {
        session.player.seekTo(session.player.currentPosition + AudioControlsService.SEEK_INTERVAL_MS)
      }
      AudioControlsService.ACTION_SEEK_BACKWARD -> {
        session.player.seekTo(session.player.currentPosition - AudioControlsService.SEEK_INTERVAL_MS)
      }
      AudioControlsService.ACTION_NEXT_TRACK -> {
        if (session.player.hasNextMediaItem()) {
          session.player.seekToNextMediaItem()
        }
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      AudioControlsService.ACTION_TOGGLE_LIKE -> {
        try {
          val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse(AudioControlsService.ACTION_TOGGLE_LIKE_URI)).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
          }
          context.startActivity(launchIntent)
        } catch (e: Exception) {
          return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_UNKNOWN))
        }
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
    }
    return super.onCustomCommand(session, controller, command, args)
  }
}
