package com.mp3platform.android

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException

class GroovyArtworkContentProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    NativeDiagnosticsLogger.info(context, "GroovyArtworkContentProvider created")
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?
  ): Cursor {
    val file = resolveFile(uri) ?: throw FileNotFoundException("Artwork not found for $uri")
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    val cursor = MatrixCursor(columns, 1)
    val values = Array<Any?>(columns.size) { index ->
      when (columns[index]) {
        OpenableColumns.DISPLAY_NAME -> file.name
        OpenableColumns.SIZE -> file.length()
        else -> null
      }
    }
    cursor.addRow(values)
    return cursor
  }

  override fun getType(uri: Uri): String = "image/jpeg"

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    val file = resolveFile(uri) ?: throw FileNotFoundException("Artwork not found for $uri")
    NativeDiagnosticsLogger.info(
      context,
      "GroovyArtworkContentProvider openFile",
      JSONObject()
        .put("uri", uri.toString())
        .put("path", file.absolutePath)
        .put("length", file.length())
    )
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

  private fun resolveFile(uri: Uri): File? {
    val currentContext = context ?: return null
    val segments = uri.pathSegments ?: return null
    if (segments.size < 2) {
      NativeDiagnosticsLogger.warn(currentContext, "GroovyArtworkContentProvider invalid URI path", JSONObject().put("uri", uri.toString()))
      return null
    }

    val category = segments[0]
    val fileName = Uri.decode(segments[1])
    val baseDirectory = when (category) {
      "covers" -> File(currentContext.filesDir, "media/covers")
      "lockscreen" -> File(currentContext.cacheDir, "lockscreen-artwork")
      else -> null
    } ?: return null

    val targetFile = File(baseDirectory, fileName)
    val canonicalBase = baseDirectory.canonicalFile
    val canonicalTarget = try {
      targetFile.canonicalFile
    } catch (_: Throwable) {
      return null
    }

    if (!canonicalTarget.path.startsWith(canonicalBase.path) || !canonicalTarget.exists()) {
      NativeDiagnosticsLogger.warn(
        currentContext,
        "GroovyArtworkContentProvider rejected file request",
        JSONObject()
          .put("uri", uri.toString())
          .put("candidatePath", targetFile.absolutePath)
      )
      return null
    }

    return canonicalTarget
  }

  companion object {
    const val AUTHORITY = "com.mp3platform.android.mediaartwork"
  }
}
