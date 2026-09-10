#pragma once

#include <stddef.h>
#include <stdint.h>

/**
 * Incomplete UTF-8 hold for native /sync/stream chunking (FM-PS-LYNX-014 N2).
 *
 * Returns how many trailing bytes do not form a complete UTF-8 sequence, so
 * those bytes stay in a carry buffer and PrimJS only sees well-formed strings.
 *
 * iOS StreamingHttp.mm includes this header. Android StreamingHttp.java calls
 * it through JNI (android/src/main/cpp/utf8_hold_jni.cc).
 *
 * Lynx-bundle JS keeps a copy in src/sync/transport/bytes.ts for host-fetch
 * bodies; shared/fixtures/sync-stream.json scenario "split-multibyte" pins
 * both implementations to the same wire bytes.
 *
 * Same rules as trailingIncompleteUtf8Bytes in bytes.ts:
 * - ASCII / complete sequences → 0
 * - truncated 2/3/4-byte sequence at the end → continuation+1
 * - all-continuation buffer → len
 * - invalid lead → 0 (do not hold; caller decodes as-is)
 */
static inline size_t ps_utf8_trailing_incomplete(const uint8_t* bytes, size_t len) {
  if (bytes == NULL || len == 0) {
    return 0;
  }
  size_t i = len - 1;
  size_t continuation = 0;
  for (;;) {
    if ((bytes[i] & 0xc0u) != 0x80u) {
      break;
    }
    continuation++;
    if (i == 0) {
      return len;
    }
    i--;
  }
  const uint8_t lead = bytes[i];
  size_t expected = 0;
  if ((lead & 0x80u) == 0) {
    expected = 0;
  } else if ((lead & 0xe0u) == 0xc0u) {
    expected = 1;
  } else if ((lead & 0xf0u) == 0xe0u) {
    expected = 2;
  } else if ((lead & 0xf8u) == 0xf0u) {
    expected = 3;
  } else {
    return 0;
  }
  if (continuation < expected) {
    return continuation + 1;
  }
  return 0;
}
