package com.powersync.lynx;

/**
 * Generated from {@code shared/sync_http_policy.h}. Do not edit.
 *
 * <p>Regenerate with {@code node scripts/gen-sync-http-policy-java.mjs}.
 * Linux {@code make test} fails if these constants drift from the header.
 */
final class SyncHttpPolicy {
  static final long IDLE_COMPLETE_MS = 2_500L;
  static final long CONNECT_TIMEOUT_MS = 30_000L;
  static final long BUFFERED_READ_TIMEOUT_MS = 30_000L;
  static final long STREAM_READ_TIMEOUT_MS = 120_000L;
  static final long STREAM_RESOURCE_TIMEOUT_MS = 0L;
  static final String STREAM_EVENT_PREFIX = "NativePowerSyncHttpStream";
  static final String EVENT_ON_DATA = "onData";
  static final String EVENT_ON_ERROR = "onError";
  static final String EVENT_ON_END = "onEnd";

  private SyncHttpPolicy() {}
}
