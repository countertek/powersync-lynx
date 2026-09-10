#include "sync_http_session.h"

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifndef PS_ANDROID_NATIVE_SYNC_HTTP_JAVA
#define PS_ANDROID_NATIVE_SYNC_HTTP_JAVA \
  "android/src/main/java/com/powersync/lynx/NativeSyncHttp.java"
#endif
#ifndef PS_ANDROID_SYNC_HTTP_SESSION_JAVA
#define PS_ANDROID_SYNC_HTTP_SESSION_JAVA \
  "android/src/main/java/com/powersync/lynx/SyncHttpSession.java"
#endif
#ifndef PS_IOS_NATIVE_SYNC_HTTP_MM
#define PS_IOS_NATIVE_SYNC_HTTP_MM "ios/src/NativeSyncHttp.mm"
#endif
#ifndef PS_ANDROID_SESSION_JNI
#define PS_ANDROID_SESSION_JNI "android/src/main/cpp/sync_http_session_jni.cc"
#endif
#ifndef PS_DESKTOP_NATIVE_MODULE_CC
#define PS_DESKTOP_NATIVE_MODULE_CC "shared/nativeModule/NativePowerSyncModule.cc"
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

struct Recorder {
  std::vector<std::string> steps;
  int dropped = 0;
};

void rec(void* ctx, const char* name) {
  static_cast<Recorder*>(ctx)->steps.emplace_back(name);
}

void rec_drop(void* ctx) {
  auto* r = static_cast<Recorder*>(ctx);
  r->steps.emplace_back("drop");
  r->dropped += 1;
}

ps_sync_http_host make_host(Recorder* rec_out) {
  ps_sync_http_host host {};
  host.ctx = rec_out;
  host.callback_headers = [](void* ctx) { rec(ctx, "callback_headers"); };
  host.callback_fail = [](void* ctx) { rec(ctx, "callback_fail"); };
  host.event_data = [](void* ctx) { rec(ctx, "event_data"); };
  host.event_error = [](void* ctx) { rec(ctx, "event_error"); };
  host.event_end = [](void* ctx) { rec(ctx, "event_end"); };
  host.cancel_io = [](void* ctx) { rec(ctx, "cancel_io"); };
  host.drop = rec_drop;
  return host;
}

std::string joined(const std::vector<std::string>& steps) {
  std::string out;
  for (size_t i = 0; i < steps.size(); ++i) {
    if (i > 0) {
      out += ",";
    }
    out += steps[i];
  }
  return out;
}

void expect_steps(const Recorder& rec_out, const char* want, const char* what) {
  const std::string got = joined(rec_out.steps);
  if (got != want) {
    std::fprintf(stderr, "FAIL: %s got [%s] want [%s]\n", what, got.c_str(), want);
    ++g_failures;
    return;
  }
  std::printf("ok: %s\n", what);
}

}  // namespace

int main() {
  expect(ps_sync_http_route(0, 1) == PS_SYNC_HTTP_ROUTE_IDLE,
         "N3-route: non-stream URL is idle-complete even with a sender");
  expect(ps_sync_http_route(1, 0) == PS_SYNC_HTTP_ROUTE_IDLE,
         "N3-route: /sync/stream without a sender is idle-complete");
  expect(ps_sync_http_route(1, 1) == PS_SYNC_HTTP_ROUTE_STREAMING,
         "N3-route: /sync/stream + sender is streamingId");
  expect(ps_sync_http_route(0, 0) == PS_SYNC_HTTP_ROUTE_IDLE,
         "N3-route: neither flag is idle-complete");

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    Recorder rec_out;
    const ps_sync_http_host host = make_host(&rec_out);
    ps_sync_http_dispatch(ps_sync_http_session_on_error(&session), &host);
    expect_steps(rec_out, "callback_fail,drop",
                 "N3-pre-headers-fail: on_error before headers is fail Callback, no events");
    expect(session.terminal.load() == 1, "N3-pre-headers-fail: terminal is claimed");
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_error(&session), &host);
    expect_steps(rec_out, "", "N3-pre-headers-fail: second on_error is ignored");
  }

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    Recorder rec_out;
    const ps_sync_http_host host = make_host(&rec_out);
    ps_sync_http_dispatch(ps_sync_http_session_on_headers(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_data(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_data(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_end(&session), &host);
    expect_steps(rec_out, "callback_headers,event_data,event_data,event_end,drop",
                 "N3-idle-vs-streaming happy path: headers + onData* + onEnd");
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_headers(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_data(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_end(&session), &host);
    expect_steps(rec_out, "", "N3-terminal: late headers/data/end after onEnd are ignored");
  }

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    Recorder rec_out;
    const ps_sync_http_host host = make_host(&rec_out);
    ps_sync_http_dispatch(ps_sync_http_session_on_headers(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_data(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_error(&session), &host);
    expect_steps(rec_out, "callback_headers,event_data,event_error,event_end,drop",
                 "N3-error-then-end: after headers, on_error emits onError then onEnd");
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_end(&session), &host);
    expect_steps(rec_out, "", "N3-error-then-end: onEnd after onError is not a second terminal");
  }

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    Recorder rec_out;
    const ps_sync_http_host host = make_host(&rec_out);
    ps_sync_http_dispatch(ps_sync_http_session_abort(&session), &host);
    expect_steps(rec_out, "cancel_io",
                 "N3-abort-before-headers: abort only cancels I/O");
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_headers(&session), &host);
    expect_steps(rec_out, "",
                 "N3-abort-before-headers: late headers after abort are not a streaming Callback");
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_error(&session), &host);
    expect_steps(rec_out, "callback_fail,drop",
                 "N3-abort-before-headers: I/O on_error is the fail envelope");
  }

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    Recorder rec_out;
    const ps_sync_http_host host = make_host(&rec_out);
    ps_sync_http_dispatch(ps_sync_http_session_on_headers(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_on_data(&session), &host);
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_abort(&session), &host);
    expect_steps(rec_out, "cancel_io",
                 "N3-abort-after-headers: abort cancels I/O and does not emit");
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_error(&session), &host);
    expect_steps(rec_out, "event_error,event_end,drop",
                 "N3-abort-after-headers: I/O on_error emits onError then onEnd");
  }

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    Recorder rec_out;
    const ps_sync_http_host host = make_host(&rec_out);
    ps_sync_http_dispatch(ps_sync_http_session_on_headers(&session), &host);
    ps_sync_http_dispatch(ps_sync_http_session_abort(&session), &host);
    rec_out.steps.clear();
    ps_sync_http_dispatch(ps_sync_http_session_on_end(&session), &host);
    expect_steps(rec_out, "event_error,event_end,drop",
                 "N3-abort-after-headers: I/O on_end after abort still emits onError then onEnd");
  }

  {
    ps_sync_http_session session;
    ps_sync_http_session_init(&session);
    expect(ps_sync_http_session_on_data(&session) == PS_SYNC_HTTP_EFFECT_NONE,
           "N3-data-before-headers is ignored");
    expect(ps_sync_http_session_on_headers(nullptr) == PS_SYNC_HTTP_EFFECT_NONE,
           "N3-null session on_headers is NONE");
    expect(ps_sync_http_session_abort(nullptr) == PS_SYNC_HTTP_EFFECT_NONE,
           "N3-null session abort is NONE");
  }

  expect(PS_SYNC_HTTP_FAIL_STATUS == -1, "N3-fail envelope status is -1");
  expect(std::string(PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT) == "httpFetch stream failed",
         "N3-fail default message");
  expect(std::string(PS_SYNC_HTTP_ABORT_MESSAGE) == "aborted", "N3-abort I/O message");

  try {
    const std::string java_http = read_file(PS_ANDROID_NATIVE_SYNC_HTTP_JAVA);
    const std::string java_session = read_file(PS_ANDROID_SYNC_HTTP_SESSION_JAVA);
    const std::string ios = read_file(PS_IOS_NATIVE_SYNC_HTTP_MM);
    const std::string jni = read_file(PS_ANDROID_SESSION_JNI);
    const std::string desktop = read_file(PS_DESKTOP_NATIVE_MODULE_CC);

    expect(java_session.find("native int nativeOnHeaders") != std::string::npos,
           "Android SyncHttpSession.java declares JNI session steps");
    expect(java_session.find("EFFECT_CALLBACK_FAIL = 2") != std::string::npos ||
               java_session.find("EFFECT_CALLBACK_FAIL = 1 << 1") != std::string::npos,
           "Android SyncHttpSession.java pins CALLBACK_FAIL bit");
    expect(java_http.find("SyncHttpSession") != std::string::npos,
           "Android NativeSyncHttp.java uses SyncHttpSession");
    expect(java_http.find("if (!headersSent") == std::string::npos,
           "Android NativeSyncHttp.java does not keep a local headersSent branch");
    expect(java_http.find("headersSent") == std::string::npos,
           "Android NativeSyncHttp.java dropped local headersSent");

    expect(ios.find("sync_http_session.h") != std::string::npos,
           "iOS NativeSyncHttp.mm includes sync_http_session.h");
    expect(ios.find("ps_sync_http_session_on_error") != std::string::npos,
           "iOS NativeSyncHttp.mm calls ps_sync_http_session_on_error");
    expect(ios.find("ps_sync_http_session_abort") != std::string::npos,
           "iOS NativeSyncHttp.mm calls ps_sync_http_session_abort");
    expect(ios.find("if (!headersSent)") == std::string::npos,
           "iOS NativeSyncHttp.mm does not keep a local headersSent branch");

    expect(jni.find("ps_sync_http_session_on_headers") != std::string::npos,
           "Android JNI forwards to ps_sync_http_session_on_headers");
    expect(jni.find("Java_com_powersync_lynx_SyncHttpSession_nativeOnError") != std::string::npos,
           "JNI symbol matches SyncHttpSession.nativeOnError");

    expect(desktop.find("sync_http_session.h") == std::string::npos,
           "desktop N-API stays SQL-only (does not include the HTTP session header)");
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: source scan: %s\n", ex.what());
    return 1;
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "%d sync-http-session check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all shared NativeSyncHttp session contract checks passed\n");
  return 0;
}
