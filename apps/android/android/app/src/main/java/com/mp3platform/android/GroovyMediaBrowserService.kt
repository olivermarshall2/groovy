package com.mp3platform.android

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.media.MediaBrowserServiceCompat
import org.json.JSONArray
import org.json.JSONObject

class GroovyMediaBrowserService : MediaBrowserServiceCompat() {
  private lateinit var mediaSession: MediaSessionCompat
  private var browserClientObserved = false
  private val diagnosticsHandler = Handler(Looper.getMainLooper())

  private fun logInfo(message: String, details: JSONObject? = null) {
    NativeDiagnosticsLogger.info(this, message, details)
  }

  private fun logWarn(message: String, details: JSONObject? = null) {
    NativeDiagnosticsLogger.warn(this, message, details)
  }

  private fun logError(message: String, error: Throwable? = null, details: JSONObject? = null) {
    NativeDiagnosticsLogger.error(this, message, error, details)
  }

  override fun onCreate() {
    super.onCreate()
    activeInstance = this

    mediaSession = MediaSessionCompat(this, "GroovyMediaBrowserService").apply {
      setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS)
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() {
          logInfo("Media browser session callback onPlay")
          // Resume the existing player queue; rebuilding it can reset the current position.
          openDeepLink("mp3platform://browser-resume-playback")
        }

        override fun onPause() {
          logInfo("Media browser session callback onPause")
          // Pause must never be implemented as a toggle because a stale session state can play or seek instead.
          openDeepLink("mp3platform://browser-pause-playback")
        }

        override fun onSkipToNext() {
          logInfo("Media browser session callback onSkipToNext")
          openDeepLink("mp3platform://next-track")
        }

        override fun onSkipToPrevious() {
          logInfo("Media browser session callback onSkipToPrevious")
          openDeepLink("mp3platform://previous-track")
        }

        override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
          if (mediaId.isNullOrBlank()) {
            logWarn("Media browser onPlayFromMediaId ignored blank mediaId")
            return
          }

          logInfo(
            "Media browser session callback onPlayFromMediaId",
            JSONObject()
              .put("mediaId", mediaId)
              .put("extras", bundleToJson(extras))
          )

          if (mediaId == ACTION_CONTINUE) {
            openDeepLink("mp3platform://browser-resume-playback")
            return
          }

          val parts = mediaId.split("|", limit = 4)
          if (parts.size != 4 || parts[0] != "track") {
            return
          }

          val source = parts[1]
          val sourceId = Uri.encode(parts[2])
          val trackId = Uri.encode(parts[3])
          openDeepLink("mp3platform://browser-play?source=$source&sourceId=$sourceId&trackId=$trackId")
        }
      })
      setSessionActivity(
        PendingIntent.getActivity(
          this@GroovyMediaBrowserService,
          1,
          packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this@GroovyMediaBrowserService, MainActivity::class.java),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      )
      isActive = true
    }

    sessionToken = mediaSession.sessionToken
    logInfo("GroovyMediaBrowserService created and session token published")
    diagnosticsHandler.postDelayed({
      if (!browserClientObserved) {
        logWarn("Media browser service has not been queried by any client yet")
      }
    }, 15000)
    refreshFromStore()
  }

  override fun onDestroy() {
    if (activeInstance === this) {
      activeInstance = null
    }
    logInfo("GroovyMediaBrowserService destroyed")
    diagnosticsHandler.removeCallbacksAndMessages(null)
    mediaSession.release()
    super.onDestroy()
  }

  override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot {
    browserClientObserved = true
    logInfo(
      "Media browser onGetRoot",
      JSONObject()
        .put("clientPackageName", clientPackageName)
        .put("clientUid", clientUid)
        .put("rootHints", bundleToJson(rootHints))
    )
    return BrowserRoot(ROOT_ID, Bundle())
  }

  override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaBrowserCompat.MediaItem>>) {
    browserClientObserved = true
    val items = buildChildren(parentId)
    logInfo(
      "Media browser onLoadChildren",
      JSONObject()
        .put("parentId", parentId)
        .put("itemCount", items.size)
        .put("sampleItems", sampleMediaItems(items))
    )
    result.sendResult(items)
  }

  fun refreshFromStore() {
    val nowPlaying = parseObject(GroovyMediaBrowserStore.loadNowPlaying(this))
    logInfo(
      "Media browser refreshFromStore",
      JSONObject()
        .put("hasNowPlaying", nowPlaying != null)
        .put("nowPlayingTrackId", nowPlaying?.optString("trackId"))
        .put("hasArtworkUri", !nowPlaying?.optString("artworkUri").isNullOrBlank())
    )
    updatePlaybackState(nowPlaying)
    updateMetadata(nowPlaying)
    notifyChildrenChanged(ROOT_ID)
    notifyChildrenChanged(CATEGORY_ALBUMS)
    notifyChildrenChanged(CATEGORY_ARTISTS)
    notifyChildrenChanged(CATEGORY_BOOKS)
    notifyChildrenChanged(CATEGORY_PLAYLISTS)
  }

  private fun buildChildren(parentId: String): MutableList<MediaBrowserCompat.MediaItem> {
    val library = parseObject(GroovyMediaBrowserStore.loadLibraryCache(this)) ?: return mutableListOf()
    val nowPlaying = parseObject(GroovyMediaBrowserStore.loadNowPlaying(this))
    val tracks = library.optJSONArray("tracks") ?: JSONArray()
    val albums = library.optJSONArray("albums") ?: JSONArray()
    val books = library.optJSONArray("books") ?: JSONArray()
    val playlists = library.optJSONArray("playlists") ?: JSONArray()

    return when (parentId) {
      ROOT_ID -> buildRootItems(nowPlaying, tracks, albums, books, playlists)
      CATEGORY_ALBUMS -> buildAlbumItems(albums)
      CATEGORY_ARTISTS -> buildArtistItems(tracks)
      CATEGORY_BOOKS -> buildBookItems(books)
      CATEGORY_PLAYLISTS -> buildPlaylistItems(playlists)
      else -> {
        when {
          parentId.startsWith("album:") -> buildTrackItemsForSource("album", parentId.removePrefix("album:"), tracks) {
            it.optString("albumId", "")
          }
          parentId.startsWith("artist:") -> buildTrackItemsForSource("artist", parentId.removePrefix("artist:"), tracks) {
            it.optString("artistId", "")
          }
          parentId.startsWith("book:") -> buildTrackItemsForSource("book", parentId.removePrefix("book:"), tracks) {
            it.optString("bookId", "")
          }
          parentId.startsWith("playlist:") -> buildPlaylistTrackItems(parentId.removePrefix("playlist:"), playlists)
          else -> mutableListOf()
        }
      }
    }
  }

  private fun buildRootItems(
    nowPlaying: JSONObject?,
    tracks: JSONArray,
    albums: JSONArray,
    books: JSONArray,
    playlists: JSONArray
  ): MutableList<MediaBrowserCompat.MediaItem> {
    val items = mutableListOf<MediaBrowserCompat.MediaItem>()
    buildContinueItem(nowPlaying)?.let { items += it }
    items += browsableItem(CATEGORY_ALBUMS, "Albums", "${albums.length()} albums")
    items += browsableItem(CATEGORY_ARTISTS, "Artists", "${collectArtists(tracks).size} artists")
    items += browsableItem(CATEGORY_BOOKS, "Books", "${books.length()} books")
    items += browsableItem(CATEGORY_PLAYLISTS, "Playlists", "${playlists.length()} playlists")
    logInfo(
      "Media browser root items built",
      JSONObject()
        .put("hasContinueItem", items.firstOrNull()?.description?.mediaId == ACTION_CONTINUE)
        .put("itemCount", items.size)
    )
    return items
  }

  private fun buildContinueItem(nowPlaying: JSONObject?): MediaBrowserCompat.MediaItem? {
    if (nowPlaying == null) {
      return null
    }

    val title = nowPlaying.optString("title").ifBlank { "Continue" }
    val subtitle = nowPlaying.optString("artist").ifBlank { nowPlaying.optString("albumTitle", "") }
    val descriptionText = nowPlaying.optString("albumTitle").ifBlank { "Resume current playback" }
    val descriptionBuilder = MediaDescriptionCompat.Builder()
      .setMediaId(ACTION_CONTINUE)
      .setTitle("Continue")
      .setSubtitle(title)
      .setDescription(if (subtitle.isNotBlank()) "$subtitle • $descriptionText" else descriptionText)

    val artworkUri = nowPlaying.optString("artworkUri").ifBlank { null }
    artworkUri?.let { descriptionBuilder.setIconUri(Uri.parse(it)) }
    logInfo(
      "Media browser continue item built",
      JSONObject()
        .put("title", title)
        .put("subtitle", subtitle)
        .put("artworkUri", artworkUri)
        .put("artworkScheme", uriScheme(artworkUri))
    )

    return MediaBrowserCompat.MediaItem(descriptionBuilder.build(), MediaBrowserCompat.MediaItem.FLAG_PLAYABLE)
  }

  private fun buildAlbumItems(albums: JSONArray): MutableList<MediaBrowserCompat.MediaItem> {
    val items = mutableListOf<MediaBrowserCompat.MediaItem>()
    for (index in 0 until albums.length()) {
      val album = albums.optJSONObject(index) ?: continue
      val albumId = album.optString("id")
      items += browsableItem(
        "album:$albumId",
        album.optString("name", "Album"),
        album.optString("artist", ""),
        extractArtworkUri(album)
      )
    }
    return items
  }

  private fun buildArtistItems(tracks: JSONArray): MutableList<MediaBrowserCompat.MediaItem> {
    val items = mutableListOf<MediaBrowserCompat.MediaItem>()
    for ((artistId, artistName) in collectArtists(tracks)) {
      items += browsableItem("artist:$artistId", artistName, "Artist", firstArtistArtworkUri(artistId, tracks))
    }
    return items
  }

  private fun buildBookItems(books: JSONArray): MutableList<MediaBrowserCompat.MediaItem> {
    val items = mutableListOf<MediaBrowserCompat.MediaItem>()
    for (index in 0 until books.length()) {
      val book = books.optJSONObject(index) ?: continue
      val bookId = book.optString("id")
      items += browsableItem(
        "book:$bookId",
        book.optString("title", "Book"),
        book.optString("author", ""),
        extractArtworkUri(book)
      )
    }
    return items
  }

  private fun buildPlaylistItems(playlists: JSONArray): MutableList<MediaBrowserCompat.MediaItem> {
    val items = mutableListOf<MediaBrowserCompat.MediaItem>()
    for (index in 0 until playlists.length()) {
      val playlist = playlists.optJSONObject(index) ?: continue
      val playlistId = playlist.optString("id")
      items += browsableItem(
        "playlist:$playlistId",
        playlist.optString("name", "Playlist"),
        playlist.optString("description", "${playlist.optInt("trackCount", 0)} tracks"),
        extractArtworkUri(playlist)
      )
    }
    return items
  }

  private fun buildTrackItemsForSource(
    source: String,
    sourceId: String,
    tracks: JSONArray,
    selector: (JSONObject) -> String
  ): MutableList<MediaBrowserCompat.MediaItem> {
    val items = mutableListOf<MediaBrowserCompat.MediaItem>()
    for (index in 0 until tracks.length()) {
      val track = tracks.optJSONObject(index) ?: continue
      if (selector(track) != sourceId) {
        continue
      }
      items += playableTrackItem(source, sourceId, track)
    }
    return items
  }

  private fun buildPlaylistTrackItems(playlistId: String, playlists: JSONArray): MutableList<MediaBrowserCompat.MediaItem> {
    for (index in 0 until playlists.length()) {
      val playlist = playlists.optJSONObject(index) ?: continue
      if (playlist.optString("id") != playlistId) {
        continue
      }

      val tracks = playlist.optJSONArray("tracks") ?: JSONArray()
      val items = mutableListOf<MediaBrowserCompat.MediaItem>()
      for (trackIndex in 0 until tracks.length()) {
        val track = tracks.optJSONObject(trackIndex) ?: continue
        items += playableTrackItem("playlist", playlistId, track)
      }
      return items
    }

    return mutableListOf()
  }

  private fun playableTrackItem(source: String, sourceId: String, track: JSONObject): MediaBrowserCompat.MediaItem {
    val trackId = track.optString("id")
    val title = track.optString("title").ifBlank { "Track" }
    val subtitle = track.optString("author").ifBlank { track.optString("artist", "") }
    val descriptionBuilder = MediaDescriptionCompat.Builder()
      .setMediaId("track|$source|$sourceId|$trackId")
      .setTitle(title)
      .setSubtitle(subtitle)
      .setDescription(track.optString("album").ifBlank { track.optString("bookTitle", "") })
    extractArtworkUri(track)?.let { artworkUri ->
      descriptionBuilder.setIconUri(Uri.parse(artworkUri))
    }
    val description = descriptionBuilder.build()

    return MediaBrowserCompat.MediaItem(description, MediaBrowserCompat.MediaItem.FLAG_PLAYABLE)
  }

  private fun browsableItem(mediaId: String, title: String, subtitle: String, artworkUri: String? = null): MediaBrowserCompat.MediaItem {
    val descriptionBuilder = MediaDescriptionCompat.Builder()
      .setMediaId(mediaId)
      .setTitle(title)
      .setSubtitle(subtitle)
    artworkUri?.let { descriptionBuilder.setIconUri(Uri.parse(it)) }
    val description = descriptionBuilder.build()

    return MediaBrowserCompat.MediaItem(description, MediaBrowserCompat.MediaItem.FLAG_BROWSABLE)
  }

  private fun collectArtists(tracks: JSONArray): LinkedHashMap<String, String> {
    val artists = linkedMapOf<String, String>()
    for (index in 0 until tracks.length()) {
      val track = tracks.optJSONObject(index) ?: continue
      val artistId = track.optString("artistId")
      val artistName = track.optString("author").ifBlank { track.optString("artist", "") }
      if (artistId.isBlank() || artistName.isBlank()) {
        continue
      }
      artists.putIfAbsent(artistId, artistName)
    }
    return artists
  }

  private fun firstArtistArtworkUri(artistId: String, tracks: JSONArray): String? {
    for (index in 0 until tracks.length()) {
      val track = tracks.optJSONObject(index) ?: continue
      if (track.optString("artistId") == artistId) {
        return extractArtworkUri(track)
      }
    }
    return null
  }

  private fun extractArtworkUri(item: JSONObject?): String? {
    if (item == null) {
      return null
    }

    val directKeys = arrayOf("coverUri", "artworkUri", "artworkUrl", "remoteUri")
    for (key in directKeys) {
      val value = item.optString(key)
      if (value.isNotBlank()) {
        return value
      }
    }

    val nestedKeys = arrayOf("cover", "artwork", "image")
    for (key in nestedKeys) {
      val nested = item.optJSONObject(key) ?: continue
      val value = extractArtworkUri(nested)
      if (!value.isNullOrBlank()) {
        return value
      }
    }

    return null
  }

  private fun updatePlaybackState(nowPlaying: JSONObject?) {
    val isPlaying = nowPlaying?.optBoolean("isPlaying") ?: false
    val positionMs = ((nowPlaying?.optDouble("positionSeconds") ?: 0.0) * 1000).toLong()
    val actions =
      PlaybackStateCompat.ACTION_PLAY or
        PlaybackStateCompat.ACTION_PAUSE or
        PlaybackStateCompat.ACTION_PLAY_PAUSE or
        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
        PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID

    val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
    logInfo(
      "Media browser playback state updated",
      JSONObject()
        .put("state", state)
        .put("positionMs", positionMs)
        .put("isPlaying", isPlaying)
        .put("hasNowPlaying", nowPlaying != null)
    )
    mediaSession.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(state, positionMs, if (isPlaying) 1f else 0f)
        .build()
    )
  }

  private fun updateMetadata(nowPlaying: JSONObject?) {
    if (nowPlaying == null) {
      logWarn("Media browser metadata cleared because nowPlaying is null")
      mediaSession.setMetadata(null)
      return
    }

    val artworkUri = nowPlaying.optString("artworkUri").ifBlank { null }
    val metadataBuilder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, nowPlaying.optString("title"))
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, nowPlaying.optString("artist"))
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, nowPlaying.optString("albumTitle"))
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, nowPlaying.optString("title"))
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, nowPlaying.optString("artist"))
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_DESCRIPTION, nowPlaying.optString("albumTitle"))
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (nowPlaying.optDouble("durationSeconds", 0.0) * 1000).toLong())

    if (!artworkUri.isNullOrBlank()) {
      metadataBuilder
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, artworkUri)
        .putString(MediaMetadataCompat.METADATA_KEY_ART_URI, artworkUri)
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, artworkUri)
    }

    val bitmap = decodeArtworkBitmap(artworkUri)
    logInfo(
      "Media browser metadata update prepared",
      JSONObject()
        .put("title", nowPlaying.optString("title"))
        .put("artist", nowPlaying.optString("artist"))
        .put("albumTitle", nowPlaying.optString("albumTitle"))
        .put("artworkUri", artworkUri)
        .put("artworkScheme", uriScheme(artworkUri))
        .put("bitmapDecoded", bitmap != null)
        .put("bitmapWidth", bitmap?.width ?: 0)
        .put("bitmapHeight", bitmap?.height ?: 0)
    )
    if (bitmap != null) {
      metadataBuilder
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bitmap)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, bitmap)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, bitmap)
    }

    mediaSession.setMetadata(metadataBuilder.build())
  }

  private fun decodeArtworkBitmap(artworkUri: String?): Bitmap? {
    if (artworkUri.isNullOrBlank()) {
      logWarn("Media browser artwork decode skipped because artworkUri is blank")
      return null
    }

    return try {
      contentResolver.openInputStream(Uri.parse(artworkUri)).use { stream ->
        if (stream == null) {
          logWarn(
            "Media browser artwork decode returned null stream",
            JSONObject().put("artworkUri", artworkUri).put("artworkScheme", uriScheme(artworkUri))
          )
          null
        } else {
          val bitmap = BitmapFactory.decodeStream(stream)
          logInfo(
            "Media browser artwork decode completed",
            JSONObject()
              .put("artworkUri", artworkUri)
              .put("artworkScheme", uriScheme(artworkUri))
              .put("bitmapDecoded", bitmap != null)
              .put("bitmapWidth", bitmap?.width ?: 0)
              .put("bitmapHeight", bitmap?.height ?: 0)
          )
          bitmap
        }
      }
    } catch (error: Throwable) {
      logError(
        "Media browser artwork decode failed",
        error,
        JSONObject().put("artworkUri", artworkUri).put("artworkScheme", uriScheme(artworkUri))
      )
      null
    }
  }

  private fun openDeepLink(url: String) {
    logInfo("Media browser deep link opened", JSONObject().put("url", url))
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    startActivity(intent)
  }

  private fun parseObject(raw: String?): JSONObject? =
    try {
      if (raw.isNullOrBlank()) null else JSONObject(raw)
    } catch (_: Throwable) {
      null
    }

  private fun uriScheme(uri: String?): String? {
    if (uri.isNullOrBlank()) {
      return null
    }
    val match = Regex("^([a-zA-Z0-9+.-]+):").find(uri)
    return match?.groupValues?.getOrNull(1)?.lowercase() ?: "relative"
  }

  private fun bundleToJson(bundle: Bundle?): JSONObject? {
    if (bundle == null) {
      return null
    }
    val json = JSONObject()
    for (key in bundle.keySet()) {
      json.put(key, bundle.get(key)?.toString())
    }
    return json
  }

  private fun sampleMediaItems(items: List<MediaBrowserCompat.MediaItem>): JSONArray {
    val array = JSONArray()
    items.take(5).forEach { item ->
      array.put(
        JSONObject()
          .put("mediaId", item.description.mediaId)
          .put("title", item.description.title?.toString())
          .put("subtitle", item.description.subtitle?.toString())
          .put("hasIconUri", item.description.iconUri != null)
          .put("flag", item.flags)
      )
    }
    return array
  }

  companion object {
    private const val ROOT_ID = "root"
    private const val ACTION_CONTINUE = "action:continue"
    private const val CATEGORY_ALBUMS = "category:albums"
    private const val CATEGORY_ARTISTS = "category:artists"
    private const val CATEGORY_BOOKS = "category:books"
    private const val CATEGORY_PLAYLISTS = "category:playlists"
    private var activeInstance: GroovyMediaBrowserService? = null

    fun refreshActiveInstance() {
      activeInstance?.refreshFromStore()
    }
  }
}
