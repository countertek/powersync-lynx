package com.powersync.lynx;

import androidx.annotation.Keep;

/**
 * JNI wrapper for {@code shared/sync_http_session.h} (FM-PS-LYNX-014 N3).
 *
 * <p>Decision bits only. HTTP I/O stays in {@link StreamingHttp} / {@link IdleCompleteHttp}.
 * Library load is {@link PsSqlEngine#ensureLoaded}.
 */
@Keep
final class SyncHttpSession {
  static final int ROUTE_IDLE = 0;
  static final int ROUTE_STREAMING = 1;

  static final int FAIL_STATUS = -1;

  static final int EFFECT_NONE = 0;
  static final int EFFECT_CALLBACK_HEADERS = 1;
  static final int EFFECT_CALLBACK_FAIL = 1 << 1;
  static final int EFFECT_EVENT_DATA = 1 << 2;
  static final int EFFECT_EVENT_ERROR = 1 << 3;
  static final int EFFECT_EVENT_END = 1 << 4;
  static final int EFFECT_CANCEL_IO = 1 << 5;
  static final int EFFECT_DROP = 1 << 6;

  private long nativeHandle;

  SyncHttpSession() {
    nativeHandle = nativeCreate();
  }

  static int route(boolean syncStreamUrl, boolean hasEventSender) {
    return nativeRoute(syncStreamUrl, hasEventSender);
  }

  synchronized int onHeaders() {
    if (nativeHandle == 0L) {
      return EFFECT_NONE;
    }
    return nativeOnHeaders(nativeHandle);
  }

  synchronized int onData() {
    if (nativeHandle == 0L) {
      return EFFECT_NONE;
    }
    return nativeOnData(nativeHandle);
  }

  synchronized int onEnd() {
    if (nativeHandle == 0L) {
      return EFFECT_NONE;
    }
    return nativeOnEnd(nativeHandle);
  }

  synchronized int onError() {
    if (nativeHandle == 0L) {
      return EFFECT_NONE;
    }
    return nativeOnError(nativeHandle);
  }

  synchronized int abort() {
    if (nativeHandle == 0L) {
      return EFFECT_NONE;
    }
    return nativeAbort(nativeHandle);
  }

  synchronized void close() {
    long handle = nativeHandle;
    nativeHandle = 0L;
    if (handle != 0L) {
      nativeDestroy(handle);
    }
  }

  private static native long nativeCreate();

  private static native void nativeDestroy(long handle);

  private static native int nativeRoute(boolean syncStreamUrl, boolean hasEventSender);

  private static native int nativeOnHeaders(long handle);

  private static native int nativeOnData(long handle);

  private static native int nativeOnEnd(long handle);

  private static native int nativeOnError(long handle);

  private static native int nativeAbort(long handle);
}
