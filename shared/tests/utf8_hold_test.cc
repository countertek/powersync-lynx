#include "utf8_hold.h"
#include "sync_stream_fixtures.h"

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifndef PS_SYNC_STREAM_FIXTURES_PATH
#define PS_SYNC_STREAM_FIXTURES_PATH "shared/fixtures/sync-stream.json"
#endif
#ifndef PS_ANDROID_STREAMING_HTTP_JAVA
#define PS_ANDROID_STREAMING_HTTP_JAVA "android/src/main/java/com/powersync/lynx/StreamingHttp.java"
#endif
#ifndef PS_IOS_STREAMING_HTTP_MM
#define PS_IOS_STREAMING_HTTP_MM "ios/src/StreamingHttp.mm"
#endif
#ifndef PS_ANDROID_UTF8_HOLD_JNI
#define PS_ANDROID_UTF8_HOLD_JNI "android/src/main/cpp/utf8_hold_jni.cc"
#endif

namespace {

int g_failures = 0;

void expect(bool cond, const char* what) {
  if (!cond) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++g_failures;
  } else {
    std::printf("ok: %s\n", what);
  }
}

std::string read_file(const char* path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error(std::string("cannot read ") + path);
  }
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

size_t hold(const std::string& bytes) {
  return ps_utf8_trailing_incomplete(reinterpret_cast<const uint8_t*>(bytes.data()),
                                     bytes.size());
}

size_t hold_raw(const uint8_t* bytes, size_t len) {
  return ps_utf8_trailing_incomplete(bytes, len);
}

std::vector<std::string> emit_held(const std::vector<std::string>& wire) {
  std::string carry;
  std::vector<std::string> emitted;
  for (const auto& piece : wire) {
    std::string combined;
    combined.reserve(carry.size() + piece.size());
    combined.append(carry);
    combined.append(piece);
    const size_t n = hold(combined);
    const size_t complete = combined.size() - n;
    if (complete > 0) {
      emitted.push_back(combined.substr(0, complete));
    }
    carry = combined.substr(complete);
  }
  if (!carry.empty()) {
    emitted.push_back(carry);
  }
  return emitted;
}

}  // namespace

int main() {
  expect(hold_raw(nullptr, 4) == 0, "null pointer holds 0");
  expect(hold(std::string()) == 0, "empty holds 0");
  expect(hold(std::string("ascii\n")) == 0, "ascii holds 0");

  const uint8_t two[] = {0xc3, 0xa9};  // é
  expect(hold_raw(two, 1) == 1, "2-byte lead alone holds 1");
  expect(hold_raw(two, 2) == 0, "complete 2-byte sequence holds 0");

  const uint8_t three[] = {0xe2, 0x82, 0xac};  // €
  expect(hold_raw(three, 1) == 1, "3-byte lead alone holds 1");
  expect(hold_raw(three, 2) == 2, "3-byte lead+1 continuation holds 2");
  expect(hold_raw(three, 3) == 0, "complete 3-byte sequence holds 0");

  const uint8_t four[] = {0xf0, 0x9f, 0x92, 0xa9};  // U+1F4A9
  expect(hold_raw(four, 1) == 1, "4-byte lead alone holds 1");
  expect(hold_raw(four, 2) == 2, "4-byte lead+1 continuation holds 2");
  expect(hold_raw(four, 3) == 3, "4-byte lead+2 continuation holds 3");
  expect(hold_raw(four, 4) == 0, "complete 4-byte sequence holds 0");

  const uint8_t only_cont[] = {0x80, 0x80};
  expect(hold_raw(only_cont, 2) == 2, "all-continuation buffer holds len");

  const uint8_t invalid_lead[] = {0xff};
  expect(hold_raw(invalid_lead, 1) == 0, "invalid lead holds 0");

  try {
    const auto catalog = ps_sync_fixtures::load_path(PS_SYNC_STREAM_FIXTURES_PATH);
    const auto* split = ps_sync_fixtures::find_scenario(catalog, "split-multibyte");
    expect(split != nullptr, "split-multibyte scenario present");
    if (split != nullptr) {
      expect(split->path == ps_sync_fixtures::kPathStreamingId, "split-multibyte is streamingId");
      expect(split->wire_chunks_hex.size() == 2, "split-multibyte has two wire hex pieces");
      expect(split->chunks.size() == 2, "split-multibyte has two well-formed onData chunks");
      expect(ps_sync_fixtures::valid_terminal_sequence(split->events),
             "split-multibyte events are onData* → onEnd");
      const auto wire = ps_sync_fixtures::wire_chunks(*split);
      expect(wire.size() == 2, "decoded wire has two pieces");
      expect(hold(wire[0]) == 1, "first wire piece holds the 3-byte euro lead");
      std::string joined_wire;
      for (const auto& piece : wire) {
        joined_wire += piece;
      }
      expect(hold(joined_wire) == 0, "concatenated wire is complete UTF-8");
      expect(joined_wire == ps_sync_fixtures::joined_body(*split),
             "wire bytes decode to the same UTF-8 as chunks");
      const auto emitted = emit_held(wire);
      expect(emitted == split->chunks, "hold emit matches fixture onData chunks");
    }
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: fixture: %s\n", ex.what());
    return 1;
  }

  try {
    const std::string java = read_file(PS_ANDROID_STREAMING_HTTP_JAVA);
    expect(java.find("static native int trailingIncompleteUtf8Bytes") != std::string::npos,
           "Android StreamingHttp.java declares JNI trailingIncompleteUtf8Bytes");
    expect(java.find("shared/utf8_hold.h") != std::string::npos,
           "Android StreamingHttp.java cites shared/utf8_hold.h");
    expect(java.find("& 0xc0") == std::string::npos,
           "Android StreamingHttp.java does not reimplement the hold loop");

    const std::string mm = read_file(PS_IOS_STREAMING_HTTP_MM);
    expect(mm.find("ps_utf8_trailing_incomplete") != std::string::npos,
           "iOS StreamingHttp.mm calls ps_utf8_trailing_incomplete");
    expect(mm.find("utf8_hold.h") != std::string::npos, "iOS StreamingHttp.mm includes utf8_hold.h");
    expect(mm.find("TrailingIncompleteUtf8Bytes") == std::string::npos,
           "iOS StreamingHttp.mm does not keep a local hold copy");

    const std::string jni = read_file(PS_ANDROID_UTF8_HOLD_JNI);
    expect(jni.find("ps_utf8_trailing_incomplete") != std::string::npos,
           "Android JNI forwards to ps_utf8_trailing_incomplete");
    expect(jni.find("Java_com_powersync_lynx_StreamingHttp_trailingIncompleteUtf8Bytes") !=
               std::string::npos,
           "JNI symbol matches StreamingHttp.trailingIncompleteUtf8Bytes");
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: source scan: %s\n", ex.what());
    return 1;
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "%d utf8-hold check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all shared utf8-hold checks passed\n");
  return 0;
}
