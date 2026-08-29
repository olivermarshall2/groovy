package com.mp3platform.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class NativeClipboardModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "NativeClipboard"

  @ReactMethod
  fun copyText(label: String, text: String, promise: Promise) {
    try {
      val clipboard = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      if (clipboard == null) {
        promise.reject("clipboard_unavailable", "Clipboard service is unavailable.")
        return
      }

      clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("clipboard_write_failed", error.message, error)
    }
  }
}
