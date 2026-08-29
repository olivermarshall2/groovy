package com.mp3platform.android

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.time.Instant

object NativeDiagnosticsLogger {
  private const val TAG = "GroovyNativeDiag"
  private const val MAX_LOG_BYTES = 2 * 1024 * 1024
  private const val LOG_FILE_NAME = "native.log"

  fun info(context: Context?, message: String, details: JSONObject? = null) {
    append(context, "INFO", message, details, null)
  }

  fun warn(context: Context?, message: String, details: JSONObject? = null) {
    append(context, "WARN", message, details, null)
  }

  fun error(context: Context?, message: String, error: Throwable? = null, details: JSONObject? = null) {
    append(context, "ERROR", message, details, error)
  }

  private fun append(context: Context?, level: String, message: String, details: JSONObject?, error: Throwable?) {
    val payload = JSONObject()
    details?.let { payload.put("details", it) }
    error?.let {
      payload.put(
        "error",
        JSONObject()
          .put("name", it::class.java.simpleName)
          .put("message", it.message ?: "")
      )
    }

    val suffix = if (payload.length() > 0) "\n${payload.toString(2)}" else ""
    val line = "[${Instant.now()}] $level $message$suffix\n\n"

    when (level) {
      "ERROR" -> Log.e(TAG, "$message ${payload.toString()}")
      "WARN" -> Log.w(TAG, "$message ${payload.toString()}")
      else -> Log.i(TAG, "$message ${payload.toString()}")
    }

    if (context == null) {
      return
    }

    try {
      val directory = File(context.filesDir, "diagnostics")
      if (!directory.exists()) {
        directory.mkdirs()
      }

      val logFile = File(directory, LOG_FILE_NAME)
      val existing = if (logFile.exists()) logFile.readText(Charsets.UTF_8) else ""
      val nextContents = trimToMaxBytes(existing + line)
      logFile.writeText(nextContents, Charsets.UTF_8)
    } catch (writeError: Throwable) {
      Log.e(TAG, "Failed to append native diagnostics", writeError)
    }
  }

  private fun trimToMaxBytes(contents: String): String {
    if (contents.toByteArray(Charsets.UTF_8).size <= MAX_LOG_BYTES) {
      return contents
    }

    var trimmed = contents
    while (trimmed.toByteArray(Charsets.UTF_8).size > MAX_LOG_BYTES && trimmed.length > 1024) {
      trimmed = trimmed.substring(trimmed.length / 8)
    }
    return trimmed
  }
}
