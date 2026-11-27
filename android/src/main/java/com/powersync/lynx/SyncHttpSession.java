package com.powersync.lynx;

import androidx.annotation.Keep;
import androidx.annotation.Nullable;

/**
 * JNI seam onto {@code shared/sync_http/sync_http_session.{h,cc}} and
 * {@code shared/sync_http_policy.h}.
 *
 * <p>C++ owns stream state transitions, incomplete UTF-8 carry/flush, error defaults, and
 * serialized effect delivery; Java only supplies {@link Sink} callbacks and HTTP I/O. Loads
 * {@code libpowersync_lynx_sql.so} independently of {@link PsSqlEngine}.
 */
@Keep
final class SyncHttpSession implements NativeSyncHttp.Session {
  @Keep
  interface Sink {
    void onHeaders(int status, String statusText, @Nullable String contentType);

    void onFail(String message);

    void onData(String utf8Chunk);

    void onError(String message);

    void onEnd();

    void cancelIo();

    void onDrop();
  }

  private static volatile boolean libraryLoaded;

  private static void ensureLoaded() {
    if (libraryLoaded) {
      return;
    }
    synchronized (SyncHttpSession.class) {
      if (!libraryLoaded) {
        System.loadLibrary("powersync_lynx_sql");
        libraryLoaded = true;
      }
    }
  }

  private long nativeHandle;
  private int inFlight = 0;
  private boolean closed = false;

  SyncHttpSession() {
    ensureLoaded();
    nativeHandle = nativeCreate();
  }

  static int route(boolean syncStreamUrl, boolean hasEventSender) {
    ensureLoaded();
    return nativeRoute(syncStreamUrl, hasEventSender);
  }

  static boolean isSyncStreamUrl(String url) {
    ensureLoaded();
    return nativeIsSyncStreamUrl(url);
  }

  static boolean looksLikeLongLived(
      String transferEncoding, String contentLength, String contentType) {
    ensureLoaded();
    return nativeLooksLikeLongLived(transferEncoding, contentLength, contentType);
  }

  @Override
  public void onHeaders(int status, String statusText, @Nullable String contentType, Sink sink) {
    long handle = acquire();
    if (handle == 0L) {
      return;
    }
    try {
      nativeOnHeaders(handle, status, statusText == null ? "" : statusText, contentType, sink);
    } finally {
      release();
    }
  }

  @Override
  public void onBytes(byte[] bytes, int offset, int length, Sink sink) {
    if (bytes == null || length <= 0) {
      return;
    }
    long handle = acquire();
    if (handle == 0L) {
      return;
    }
    try {
      nativeOnBytes(handle, bytes, offset, length, sink);
    } finally {
      release();
    }
  }

  @Override
  public void onEnd(Sink sink) {
    long handle = acquire();
    if (handle == 0L) {
      return;
    }
    try {
      nativeOnEnd(handle, sink);
    } finally {
      release();
    }
  }

  @Override
  public void onError(@Nullable String message, Sink sink) {
    long handle = acquire();
    if (handle == 0L) {
      return;
    }
    try {
      nativeOnError(handle, message, sink);
    } finally {
      release();
    }
  }

  @Override
  public void abort(Sink sink) {
    long handle = acquire();
    if (handle == 0L) {
      return;
    }
    try {
      nativeAbort(handle, sink);
    } finally {
      release();
    }
  }

  @Override
  public void close() {
    long toDestroy = 0L;
    synchronized (this) {
      if (closed) {
        return;
      }
      closed = true;
      if (inFlight == 0) {
        toDestroy = nativeHandle;
        nativeHandle = 0L;
      }
    }
    if (toDestroy != 0L) {
      nativeDestroy(toDestroy);
    }
  }

  private synchronized long acquire() {
    if (closed || nativeHandle == 0L) {
      return 0L;
    }
    inFlight += 1;
    return nativeHandle;
  }

  private void release() {
    long toDestroy = 0L;
    synchronized (this) {
      inFlight -= 1;
      if (closed && inFlight == 0 && nativeHandle != 0L) {
        toDestroy = nativeHandle;
        nativeHandle = 0L;
      }
    }
    if (toDestroy != 0L) {
      nativeDestroy(toDestroy);
    }
  }

  private static native long nativeCreate();

  private static native void nativeDestroy(long handle);

  private static native int nativeRoute(boolean syncStreamUrl, boolean hasEventSender);

  private static native boolean nativeIsSyncStreamUrl(String url);

  private static native boolean nativeLooksLikeLongLived(
      String transferEncoding, String contentLength, String contentType);

  private static native void nativeOnHeaders(
      long handle, int status, String statusText, @Nullable String contentType, Sink sink);

  private static native void nativeOnBytes(
      long handle, byte[] bytes, int offset, int length, Sink sink);

  private static native void nativeOnEnd(long handle, Sink sink);

  private static native void nativeOnError(long handle, @Nullable String message, Sink sink);

  private static native void nativeAbort(long handle, Sink sink);
}
