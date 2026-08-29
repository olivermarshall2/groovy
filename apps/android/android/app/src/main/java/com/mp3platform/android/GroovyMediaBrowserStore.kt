package com.mp3platform.android

import android.content.Context
import org.json.JSONObject

object GroovyMediaBrowserStore {
  private const val PREFS_NAME = "groovy_media_browser"
  private const val LIBRARY_CACHE_JSON_KEY = "library_cache_json"
  private const val NOW_PLAYING_JSON_KEY = "now_playing_json"

  fun saveLibraryCache(context: Context, json: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(LIBRARY_CACHE_JSON_KEY, json)
      .apply()
    NativeDiagnosticsLogger.info(
      context,
      "Native media browser library cache stored",
      JSONObject()
        .put("jsonLength", json.length)
        .put("hasAlbums", json.contains("\"albums\""))
        .put("hasBooks", json.contains("\"books\""))
        .put("hasPlaylists", json.contains("\"playlists\""))
        .put("hasTracks", json.contains("\"tracks\""))
    )
    GroovyMediaBrowserService.refreshActiveInstance()
  }

  fun loadLibraryCache(context: Context): String? =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(LIBRARY_CACHE_JSON_KEY, null)

  fun saveNowPlaying(context: Context, json: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(NOW_PLAYING_JSON_KEY, json)
      .apply()
    NativeDiagnosticsLogger.info(
      context,
      "Native media browser now playing stored",
      JSONObject()
        .put("jsonLength", json.length)
        .put("hasArtworkUri", json.contains("\"artworkUri\""))
        .put("hasTitle", json.contains("\"title\""))
        .put("hasArtist", json.contains("\"artist\""))
        .put("hasAlbumTitle", json.contains("\"albumTitle\""))
    )
    GroovyMediaBrowserService.refreshActiveInstance()
  }

  fun loadNowPlaying(context: Context): String? =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(NOW_PLAYING_JSON_KEY, null)

  fun clearNowPlaying(context: Context) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(NOW_PLAYING_JSON_KEY)
      .apply()
    NativeDiagnosticsLogger.info(context, "Native media browser now playing cleared")
    GroovyMediaBrowserService.refreshActiveInstance()
  }
}
