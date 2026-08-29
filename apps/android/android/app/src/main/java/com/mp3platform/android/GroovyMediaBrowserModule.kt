package com.mp3platform.android

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject

class GroovyMediaBrowserModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "GroovyMediaBrowser"

  @ReactMethod
  fun updateLibraryCache(cacheJson: String, promise: Promise) {
    try {
      NativeDiagnosticsLogger.info(
        reactApplicationContext,
        "GroovyMediaBrowser.updateLibraryCache invoked",
        JSONObject().put("jsonLength", cacheJson.length)
      )
      GroovyMediaBrowserStore.saveLibraryCache(reactApplicationContext, cacheJson)
      promise.resolve(null)
    } catch (error: Throwable) {
      NativeDiagnosticsLogger.error(reactApplicationContext, "GroovyMediaBrowser.updateLibraryCache failed", error)
      promise.reject("media_browser_library_cache_failed", error.message, error)
    }
  }

  @ReactMethod
  fun updateNowPlaying(nowPlayingJson: String, promise: Promise) {
    try {
      NativeDiagnosticsLogger.info(
        reactApplicationContext,
        "GroovyMediaBrowser.updateNowPlaying invoked",
        JSONObject().put("jsonLength", nowPlayingJson.length)
      )
      GroovyMediaBrowserStore.saveNowPlaying(reactApplicationContext, nowPlayingJson)
      promise.resolve(null)
    } catch (error: Throwable) {
      NativeDiagnosticsLogger.error(reactApplicationContext, "GroovyMediaBrowser.updateNowPlaying failed", error)
      promise.reject("media_browser_now_playing_failed", error.message, error)
    }
  }

  @ReactMethod
  fun clearNowPlaying(promise: Promise) {
    try {
      NativeDiagnosticsLogger.info(reactApplicationContext, "GroovyMediaBrowser.clearNowPlaying invoked")
      GroovyMediaBrowserStore.clearNowPlaying(reactApplicationContext)
      promise.resolve(null)
    } catch (error: Throwable) {
      NativeDiagnosticsLogger.error(reactApplicationContext, "GroovyMediaBrowser.clearNowPlaying failed", error)
      promise.reject("media_browser_clear_now_playing_failed", error.message, error)
    }
  }

  @ReactMethod
  fun buildArtworkContentUri(fileUri: String, promise: Promise) {
    try {
      val uri = android.net.Uri.parse(fileUri)
      val path = uri.path
      if (path.isNullOrBlank()) {
        promise.resolve(null)
        return
      }

      val file = java.io.File(path)
      if (!file.exists()) {
        promise.resolve(null)
        return
      }

      val filesCoversDirectory = java.io.File(reactApplicationContext.filesDir, "media/covers").canonicalFile
      val cacheLockscreenDirectory = java.io.File(reactApplicationContext.cacheDir, "lockscreen-artwork").canonicalFile
      val canonicalTarget = file.canonicalFile
      val category = when {
        canonicalTarget.path.startsWith(filesCoversDirectory.path) -> "covers"
        canonicalTarget.path.startsWith(cacheLockscreenDirectory.path) -> "lockscreen"
        else -> null
      }

      if (category == null) {
        promise.resolve(null)
        return
      }

      val contentUri = android.net.Uri.Builder()
        .scheme("content")
        .authority(GroovyArtworkContentProvider.AUTHORITY)
        .appendPath(category)
        .appendPath(android.net.Uri.encode(canonicalTarget.name))
        .build()
        .toString()

      NativeDiagnosticsLogger.info(
        reactApplicationContext,
        "GroovyMediaBrowser.buildArtworkContentUri created",
        JSONObject()
          .put("fileUri", fileUri)
          .put("contentUri", contentUri)
          .put("category", category)
      )

      promise.resolve(contentUri)
    } catch (error: Throwable) {
      NativeDiagnosticsLogger.error(reactApplicationContext, "GroovyMediaBrowser.buildArtworkContentUri failed", error)
      promise.reject("media_browser_build_artwork_content_uri_failed", error.message, error)
    }
  }
}
