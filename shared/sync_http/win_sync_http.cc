#include "sync_http_engine.h"

#if defined(_WIN32)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winhttp.h>

#include "sync_http_policy.h"
#include "win_utf8.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ps_sync_http {

namespace {

std::string FormatWinHttpError(const char* op, DWORD err) {
  return std::string(op) + " failed (WinHTTP error " + std::to_string(err) + ")";
}

struct ParsedUrl {
  std::wstring host;
  std::wstring path_and_query;
  INTERNET_PORT port = INTERNET_DEFAULT_HTTP_PORT;
  bool secure = false;
};

bool CrackUrlUtf8(const std::string& url, ParsedUrl* out, std::string* error) {
  const std::wstring wide_url = ps_sql::Utf8ToWide(url);
  if (wide_url.empty()) {
    if (error != nullptr) {
      *error = "httpFetch invalid url";
    }
    return false;
  }

  URL_COMPONENTSW components{};
  components.dwStructSize = sizeof(components);
  components.dwSchemeLength = static_cast<DWORD>(-1);
  components.dwHostNameLength = static_cast<DWORD>(-1);
  components.dwUrlPathLength = static_cast<DWORD>(-1);
  components.dwExtraInfoLength = static_cast<DWORD>(-1);

  if (!WinHttpCrackUrl(wide_url.c_str(), static_cast<DWORD>(wide_url.size()), 0,
                       &components)) {
    if (error != nullptr) {
      *error = "httpFetch invalid url";
    }
    return false;
  }

  if (components.nScheme != INTERNET_SCHEME_HTTP &&
      components.nScheme != INTERNET_SCHEME_HTTPS) {
    if (error != nullptr) {
      *error = "httpFetch unsupported url scheme";
    }
    return false;
  }

  out->host.assign(components.lpszHostName, components.dwHostNameLength);
  if (components.dwUrlPathLength > 0) {
    out->path_and_query.assign(components.lpszUrlPath,
                               components.dwUrlPathLength);
  } else {
    out->path_and_query = L"/";
  }
  if (components.dwExtraInfoLength > 0) {
    out->path_and_query.append(components.lpszExtraInfo,
                               components.dwExtraInfoLength);
  }
  out->port = components.nPort;
  out->secure = (components.nScheme == INTERNET_SCHEME_HTTPS);
  return true;
}

HINTERNET OpenWinHttpSession() {
  HINTERNET session = WinHttpOpen(L"powersync-lynx/0.3.0",
                                  WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                  WINHTTP_NO_PROXY_NAME,
                                  WINHTTP_NO_PROXY_BYPASS, 0);
  if (session == nullptr) {
    session = WinHttpOpen(L"powersync-lynx/0.3.0",
                          WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                          WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  }
  return session;
}

std::string QueryHeaderUtf8(HINTERNET req, DWORD query_flags) {
  DWORD bytes = 0;
  WinHttpQueryHeaders(req, query_flags, WINHTTP_HEADER_NAME_BY_INDEX, nullptr,
                      &bytes, WINHTTP_NO_HEADER_INDEX);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
    return {};
  }
  std::wstring wide(bytes / sizeof(wchar_t), L'\0');
  if (!WinHttpQueryHeaders(req, query_flags, WINHTTP_HEADER_NAME_BY_INDEX,
                           &wide[0], &bytes, WINHTTP_NO_HEADER_INDEX)) {
    return {};
  }
  while (!wide.empty() && wide.back() == L'\0') {
    wide.pop_back();
  }
  return ps_sql::WideToUtf8(wide.c_str(), static_cast<int>(wide.size()));
}

int QueryStatusCode(HINTERNET req) {
  DWORD status_code = 0;
  DWORD size = sizeof(status_code);
  if (!WinHttpQueryHeaders(
          req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
          WINHTTP_HEADER_NAME_BY_INDEX, &status_code, &size,
          WINHTTP_NO_HEADER_INDEX)) {
    return 0;
  }
  return static_cast<int>(status_code);
}

void AddRequestHeaders(
    HINTERNET req,
    const std::vector<std::pair<std::string, std::string>>& headers) {
  for (const auto& kv : headers) {
    if (kv.first.empty()) {
      continue;
    }
    const std::wstring line = ps_sql::Utf8ToWide(kv.first + ": " + kv.second);
    if (!line.empty()) {
      WinHttpAddRequestHeaders(
          req, line.c_str(), static_cast<DWORD>(line.size()),
          WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
    }
  }
}

class ScopedHandle {
 public:
  explicit ScopedHandle(HINTERNET h = nullptr) : h_(h) {}
  ~ScopedHandle() { reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : h_(other.h_) {
    other.h_ = nullptr;
  }
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) {
      reset(other.h_);
      other.h_ = nullptr;
    }
    return *this;
  }
  void reset(HINTERNET next = nullptr) {
    if (h_ != nullptr) {
      WinHttpCloseHandle(h_);
    }
    h_ = next;
  }
  HINTERNET get() const { return h_; }
  explicit operator bool() const { return h_ != nullptr; }

 private:
  HINTERNET h_;
};

struct OpenedWinHttpRequest {
  ScopedHandle session;
  ScopedHandle conn;
  HINTERNET req = nullptr;
};

// Shared WinHTTP session -> connect -> open -> headers -> send -> receive setup
// used by both streaming and idle-complete requests. `bind_request` transfers
// ownership of the request handle before send/receive so cancellation can close it.
bool OpenAndSendWinHttpRequest(
    const HttpRequest& request, DWORD receive_timeout_ms,
    const std::function<bool(HINTERNET)>& bind_request,
    const std::function<bool()>& is_cancelled,
    OpenedWinHttpRequest* out, std::string* error_out) {
  ParsedUrl parsed;
  if (!CrackUrlUtf8(request.url, &parsed, error_out)) {
    return false;
  }
  if (is_cancelled && is_cancelled()) {
    *error_out = PS_SYNC_HTTP_ABORT_MESSAGE;
    return false;
  }

  out->session.reset(OpenWinHttpSession());
  if (!out->session) {
    *error_out = FormatWinHttpError("WinHttpOpen", GetLastError());
    return false;
  }

  WinHttpSetTimeouts(out->session.get(), PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                     PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                     PS_SYNC_HTTP_CONNECT_TIMEOUT_MS, receive_timeout_ms);

  if (is_cancelled && is_cancelled()) {
    *error_out = PS_SYNC_HTTP_ABORT_MESSAGE;
    return false;
  }

  out->conn.reset(
      WinHttpConnect(out->session.get(), parsed.host.c_str(), parsed.port, 0));
  if (!out->conn) {
    *error_out = FormatWinHttpError("WinHttpConnect", GetLastError());
    return false;
  }

  const std::wstring wide_method = ps_sql::Utf8ToWide(request.method);
  const DWORD flags = parsed.secure ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET req = WinHttpOpenRequest(
      out->conn.get(), wide_method.c_str(), parsed.path_and_query.c_str(),
      nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (req == nullptr) {
    *error_out = FormatWinHttpError("WinHttpOpenRequest", GetLastError());
    return false;
  }
  if (bind_request && !bind_request(req)) {
    *error_out = PS_SYNC_HTTP_ABORT_MESSAGE;
    return false;
  }
  out->req = req;

  AddRequestHeaders(req, request.headers);

  LPVOID body_ptr =
      request.body.empty()
          ? WINHTTP_NO_REQUEST_DATA
          : const_cast<char*>(request.body.data());
  const DWORD body_len = static_cast<DWORD>(request.body.size());

  if (!WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, body_ptr,
                          body_len, body_len, 0)) {
    *error_out = FormatWinHttpError("WinHttpSendRequest", GetLastError());
    return false;
  }

  if (!WinHttpReceiveResponse(req, nullptr)) {
    *error_out = FormatWinHttpError("WinHttpReceiveResponse", GetLastError());
    return false;
  }

  if (is_cancelled && is_cancelled()) {
    *error_out = PS_SYNC_HTTP_ABORT_MESSAGE;
    return false;
  }

  return true;
}

class WinHttpStreamTask final
    : public PlatformStreamTask,
      public std::enable_shared_from_this<WinHttpStreamTask> {
 public:
  WinHttpStreamTask(HttpRequest request, PlatformStreamCallbacks callbacks)
      : request_(std::move(request)), callbacks_(std::move(callbacks)) {}

  ~WinHttpStreamTask() override { CloseRequestHandle(); }

  void Start() {
    auto self = shared_from_this();
    std::thread([self = std::move(self)]() { self->Run(); }).detach();
  }

  void Cancel() override {
    cancelled_.store(true);
    // Interrupt any blocking call on the request handle without racing
    // Run()'s local session/connection ScopedHandles.
    CloseRequestHandle();
  }

 private:
  bool AssignRequestHandle(HINTERNET handle) {
    if (handle == nullptr) {
      return false;
    }
    std::lock_guard<std::mutex> lock(req_mutex_);
    if (cancelled_.load()) {
      WinHttpCloseHandle(handle);
      return false;
    }
    req_ = handle;
    return true;
  }

  void CloseRequestHandle() {
    HINTERNET req = nullptr;
    {
      std::lock_guard<std::mutex> lock(req_mutex_);
      req = req_;
      req_ = nullptr;
    }
    if (req != nullptr) {
      WinHttpCloseHandle(req);
    }
  }

  void ClearCallbacks() {
    callbacks_.on_headers = nullptr;
    callbacks_.on_bytes = nullptr;
    callbacks_.on_end = nullptr;
    callbacks_.on_error = nullptr;
  }

  void FinishError(const std::string& message) {
    CloseRequestHandle();
    if (finished_.exchange(true)) {
      return;
    }
    auto on_error = std::move(callbacks_.on_error);
    ClearCallbacks();
    if (on_error) {
      on_error(cancelled_.load() ? PS_SYNC_HTTP_ABORT_MESSAGE : message);
    }
  }

  void FinishEnd() {
    CloseRequestHandle();
    if (finished_.exchange(true)) {
      return;
    }
    auto on_error = std::move(callbacks_.on_error);
    auto on_end = std::move(callbacks_.on_end);
    ClearCallbacks();
    if (cancelled_.load()) {
      if (on_error) {
        on_error(PS_SYNC_HTTP_ABORT_MESSAGE);
      }
    } else if (on_end) {
      on_end();
    }
  }

  void Run() {
    OpenedWinHttpRequest opened;
    std::string err;
    if (!OpenAndSendWinHttpRequest(
            request_, PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS,
            [this](HINTERNET h) { return AssignRequestHandle(h); },
            [this]() { return cancelled_.load(); }, &opened, &err)) {
      FinishError(err);
      return;
    }

    HINTERNET req = opened.req;
    const int status = QueryStatusCode(req);
    const std::string status_text =
        QueryHeaderUtf8(req, WINHTTP_QUERY_STATUS_TEXT);
    const std::string content_type =
        QueryHeaderUtf8(req, WINHTTP_QUERY_CONTENT_TYPE);

    if (callbacks_.on_headers) {
      callbacks_.on_headers(status, status_text, content_type);
    }

    uint8_t buf[4096];
    for (;;) {
      if (cancelled_.load()) {
        FinishError(PS_SYNC_HTTP_ABORT_MESSAGE);
        return;
      }
      DWORD avail = 0;
      if (!WinHttpQueryDataAvailable(req, &avail)) {
        FinishError(
            FormatWinHttpError("WinHttpQueryDataAvailable", GetLastError()));
        return;
      }
      if (avail == 0) {
        break;
      }
      const DWORD to_read =
          avail < sizeof(buf) ? avail : static_cast<DWORD>(sizeof(buf));
      DWORD bytes_read = 0;
      if (!WinHttpReadData(req, buf, to_read, &bytes_read)) {
        FinishError(FormatWinHttpError("WinHttpReadData", GetLastError()));
        return;
      }
      if (bytes_read == 0) {
        break;
      }
      if (callbacks_.on_bytes) {
        callbacks_.on_bytes(buf, static_cast<size_t>(bytes_read));
      }
    }

    FinishEnd();
  }

  HttpRequest request_;
  PlatformStreamCallbacks callbacks_;
  std::mutex req_mutex_;
  HINTERNET req_ = nullptr;
  std::atomic<bool> cancelled_{false};
  std::atomic<bool> finished_{false};
};

IdleHttpOutcome RunWinHttpIdleComplete(const HttpRequest& request,
                                       bool is_sync_stream) {
  IdleHttpOutcome outcome;
  OpenedWinHttpRequest opened;
  ScopedHandle owned_req;
  if (!OpenAndSendWinHttpRequest(
          request, PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS,
          [&owned_req](HINTERNET h) {
            owned_req.reset(h);
            return true;
          },
          nullptr, &opened, &outcome.error)) {
    return outcome;
  }

  HINTERNET req = owned_req.get();
  outcome.status = QueryStatusCode(req);
  outcome.status_text = QueryHeaderUtf8(req, WINHTTP_QUERY_STATUS_TEXT);
  outcome.content_type = QueryHeaderUtf8(req, WINHTTP_QUERY_CONTENT_TYPE);
  const std::string transfer_encoding =
      QueryHeaderUtf8(req, WINHTTP_QUERY_TRANSFER_ENCODING);
  const std::string content_length =
      QueryHeaderUtf8(req, WINHTTP_QUERY_CONTENT_LENGTH);

  const bool long_lived =
      is_sync_stream ||
      ps_sync_http_looks_like_long_lived(
          transfer_encoding.empty() ? nullptr : transfer_encoding.c_str(),
          content_length.empty() ? nullptr : content_length.c_str(),
          outcome.content_type.empty() ? nullptr : outcome.content_type.c_str()) != 0;

  uint8_t buf[4096];
  bool lowered_idle_timeout = false;

  for (;;) {
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(req, &avail)) {
      const DWORD err = GetLastError();
      if (long_lived && !outcome.bytes.empty() && err == ERROR_WINHTTP_TIMEOUT) {
        outcome.idle_timed_out = true;
        break;
      }
      outcome.error = FormatWinHttpError("WinHttpQueryDataAvailable", err);
      return outcome;
    }
    if (avail == 0) {
      break;
    }
    const DWORD to_read =
        avail < sizeof(buf) ? avail : static_cast<DWORD>(sizeof(buf));
    DWORD bytes_read = 0;
    if (!WinHttpReadData(req, buf, to_read, &bytes_read)) {
      const DWORD err = GetLastError();
      if (long_lived && !outcome.bytes.empty() && err == ERROR_WINHTTP_TIMEOUT) {
        outcome.idle_timed_out = true;
        break;
      }
      outcome.error = FormatWinHttpError("WinHttpReadData", err);
      return outcome;
    }
    if (bytes_read == 0) {
      break;
    }
    outcome.bytes.insert(outcome.bytes.end(), buf, buf + bytes_read);
    if (long_lived && !lowered_idle_timeout) {
      lowered_idle_timeout = true;
      WinHttpSetTimeouts(req, PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                         PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                         PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                         PS_SYNC_HTTP_IDLE_COMPLETE_MS);
    }
  }

  return outcome;
}

class WinPlatformTransport final : public PlatformTransport {
 public:
  std::shared_ptr<PlatformStreamTask> StartStreaming(
      const HttpRequest& request, PlatformStreamCallbacks callbacks) override {
    auto task =
        std::make_shared<WinHttpStreamTask>(request, std::move(callbacks));
    task->Start();
    return task;
  }

  void StartIdleComplete(const HttpRequest& request, bool is_sync_stream,
                         IdleOutcomeCallback callback) override {
    if (!callback) {
      return;
    }
    std::thread([request, is_sync_stream,
                 callback = std::move(callback)]() mutable {
      callback(RunWinHttpIdleComplete(request, is_sync_stream));
    }).detach();
  }
};

}  // namespace

std::shared_ptr<PlatformTransport> DefaultPlatformTransport() {
  return std::make_shared<WinPlatformTransport>();
}

}  // namespace ps_sync_http

#endif  // defined(_WIN32)
