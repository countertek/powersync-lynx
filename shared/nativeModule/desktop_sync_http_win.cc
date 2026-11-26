#include "desktop_sync_http.h"

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
#include "sync_http_session.h"
#include "win_utf8.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ps_desktop_http {

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
  if (url.empty()) {
    if (error != nullptr) {
      *error = "httpFetch requires string url";
    }
    return false;
  }
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

class WinHttpStreamTask final
    : public PlatformStreamTask,
      public std::enable_shared_from_this<WinHttpStreamTask> {
 public:
  WinHttpStreamTask(HttpRequest request, PlatformStreamCallbacks callbacks)
      : request_(std::move(request)), callbacks_(std::move(callbacks)) {}

  ~WinHttpStreamTask() override { CloseHandles(); }

  void Start() {
    auto self = shared_from_this();
    std::thread([self = std::move(self)]() { self->Run(); }).detach();
  }

  void Cancel() override {
    cancelled_.store(true);
    CloseHandles();
  }

 private:
  bool AssignHandle(HINTERNET* slot, HINTERNET handle) {
    if (handle == nullptr) {
      return false;
    }
    std::lock_guard<std::mutex> lock(handle_mutex_);
    if (cancelled_.load()) {
      WinHttpCloseHandle(handle);
      return false;
    }
    *slot = handle;
    return true;
  }

  void CloseHandles() {
    HINTERNET req = nullptr;
    HINTERNET conn = nullptr;
    HINTERNET sess = nullptr;
    {
      std::lock_guard<std::mutex> lock(handle_mutex_);
      req = req_;
      conn = conn_;
      sess = sess_;
      req_ = nullptr;
      conn_ = nullptr;
      sess_ = nullptr;
    }
    if (req != nullptr) {
      WinHttpCloseHandle(req);
    }
    if (conn != nullptr) {
      WinHttpCloseHandle(conn);
    }
    if (sess != nullptr) {
      WinHttpCloseHandle(sess);
    }
  }

  void FinishError(const std::string& message) {
    CloseHandles();
    if (callbacks_.on_error) {
      callbacks_.on_error(cancelled_.load() ? PS_SYNC_HTTP_ABORT_MESSAGE
                                            : message);
    }
  }

  void Run() {
    ParsedUrl parsed;
    std::string parse_err;
    if (!CrackUrlUtf8(request_.url, &parsed, &parse_err)) {
      FinishError(parse_err);
      return;
    }

    HINTERNET session = OpenWinHttpSession();
    if (!AssignHandle(&sess_, session)) {
      FinishError(FormatWinHttpError("WinHttpOpen", GetLastError()));
      return;
    }

    WinHttpSetTimeouts(session, PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                       PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                       PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                       PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS);

    HINTERNET conn =
        WinHttpConnect(session, parsed.host.c_str(), parsed.port, 0);
    if (!AssignHandle(&conn_, conn)) {
      FinishError(FormatWinHttpError("WinHttpConnect", GetLastError()));
      return;
    }

    const std::string method =
        request_.method.empty() ? std::string("GET") : request_.method;
    const std::wstring wide_method = ps_sql::Utf8ToWide(method);
    const DWORD flags = parsed.secure ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET req = WinHttpOpenRequest(
        conn, wide_method.c_str(), parsed.path_and_query.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!AssignHandle(&req_, req)) {
      FinishError(FormatWinHttpError("WinHttpOpenRequest", GetLastError()));
      return;
    }

    AddRequestHeaders(req, request_.headers);

    LPVOID body_ptr =
        request_.body.empty()
            ? WINHTTP_NO_REQUEST_DATA
            : const_cast<char*>(request_.body.data());
    const DWORD body_len = static_cast<DWORD>(request_.body.size());

    if (!WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, body_ptr,
                            body_len, body_len, 0)) {
      FinishError(FormatWinHttpError("WinHttpSendRequest", GetLastError()));
      return;
    }

    if (!WinHttpReceiveResponse(req, nullptr)) {
      FinishError(FormatWinHttpError("WinHttpReceiveResponse", GetLastError()));
      return;
    }

    if (cancelled_.load()) {
      FinishError(PS_SYNC_HTTP_ABORT_MESSAGE);
      return;
    }

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
      DWORD bytes_read = 0;
      if (!WinHttpReadData(req, buf, sizeof(buf), &bytes_read)) {
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

    CloseHandles();
    if (cancelled_.load()) {
      if (callbacks_.on_error) {
        callbacks_.on_error(PS_SYNC_HTTP_ABORT_MESSAGE);
      }
    } else if (callbacks_.on_end) {
      callbacks_.on_end();
    }
  }

  HttpRequest request_;
  PlatformStreamCallbacks callbacks_;
  std::mutex handle_mutex_;
  HINTERNET sess_ = nullptr;
  HINTERNET conn_ = nullptr;
  HINTERNET req_ = nullptr;
  std::atomic<bool> cancelled_{false};
};

class ScopedHandle {
 public:
  explicit ScopedHandle(HINTERNET h = nullptr) : h_(h) {}
  ~ScopedHandle() {
    if (h_ != nullptr) {
      WinHttpCloseHandle(h_);
    }
  }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  HINTERNET get() const { return h_; }
  explicit operator bool() const { return h_ != nullptr; }

 private:
  HINTERNET h_;
};

HttpResponseEnvelope RunWinHttpIdleComplete(const HttpRequest& request,
                                            bool is_sync_stream) {
  ParsedUrl parsed;
  std::string parse_err;
  if (!CrackUrlUtf8(request.url, &parsed, &parse_err)) {
    return MakeIdleErrorEnvelope(-1, parse_err);
  }

  ScopedHandle session(OpenWinHttpSession());
  if (!session) {
    return MakeIdleErrorEnvelope(
        -1, FormatWinHttpError("WinHttpOpen", GetLastError()));
  }

  WinHttpSetTimeouts(session.get(), PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                     PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                     PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                     PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS);

  ScopedHandle conn(
      WinHttpConnect(session.get(), parsed.host.c_str(), parsed.port, 0));
  if (!conn) {
    return MakeIdleErrorEnvelope(
        -1, FormatWinHttpError("WinHttpConnect", GetLastError()));
  }

  const std::string method =
      request.method.empty() ? std::string("GET") : request.method;
  const std::wstring wide_method = ps_sql::Utf8ToWide(method);
  const DWORD flags = parsed.secure ? WINHTTP_FLAG_SECURE : 0;
  ScopedHandle req(WinHttpOpenRequest(
      conn.get(), wide_method.c_str(), parsed.path_and_query.c_str(), nullptr,
      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
  if (!req) {
    return MakeIdleErrorEnvelope(
        -1, FormatWinHttpError("WinHttpOpenRequest", GetLastError()));
  }

  AddRequestHeaders(req.get(), request.headers);

  LPVOID body_ptr = request.body.empty()
                        ? WINHTTP_NO_REQUEST_DATA
                        : const_cast<char*>(request.body.data());
  const DWORD body_len = static_cast<DWORD>(request.body.size());

  if (!WinHttpSendRequest(req.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, body_ptr,
                          body_len, body_len, 0)) {
    return MakeIdleErrorEnvelope(
        -1, FormatWinHttpError("WinHttpSendRequest", GetLastError()));
  }

  if (!WinHttpReceiveResponse(req.get(), nullptr)) {
    return MakeIdleErrorEnvelope(
        -1, FormatWinHttpError("WinHttpReceiveResponse", GetLastError()));
  }

  const int status = QueryStatusCode(req.get());
  const std::string status_text =
      QueryHeaderUtf8(req.get(), WINHTTP_QUERY_STATUS_TEXT);
  const std::string content_type =
      QueryHeaderUtf8(req.get(), WINHTTP_QUERY_CONTENT_TYPE);
  const std::string transfer_encoding =
      QueryHeaderUtf8(req.get(), WINHTTP_QUERY_TRANSFER_ENCODING);
  const std::string content_length =
      QueryHeaderUtf8(req.get(), WINHTTP_QUERY_CONTENT_LENGTH);

  const bool long_lived =
      is_sync_stream ||
      ps_sync_http_looks_like_long_lived(
          transfer_encoding.empty() ? nullptr : transfer_encoding.c_str(),
          content_length.empty() ? nullptr : content_length.c_str(),
          content_type.empty() ? nullptr : content_type.c_str()) != 0;

  std::vector<uint8_t> body;
  uint8_t buf[4096];
  bool lowered_idle_timeout = false;
  bool idle_completed = false;

  for (;;) {
    DWORD bytes_read = 0;
    if (!WinHttpReadData(req.get(), buf, sizeof(buf), &bytes_read)) {
      const DWORD err = GetLastError();
      if (long_lived && !body.empty() && err == ERROR_WINHTTP_TIMEOUT) {
        idle_completed = true;
        break;
      }
      if (!body.empty() && is_sync_stream) {
        idle_completed = true;
        break;
      }
      return MakeIdleErrorEnvelope(-1, FormatWinHttpError("WinHttpReadData", err));
    }
    if (bytes_read == 0) {
      break;
    }
    body.insert(body.end(), buf, buf + bytes_read);
    if (long_lived && !lowered_idle_timeout) {
      lowered_idle_timeout = true;
      WinHttpSetTimeouts(req.get(), PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                         PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                         PS_SYNC_HTTP_CONNECT_TIMEOUT_MS,
                         PS_SYNC_HTTP_IDLE_COMPLETE_MS);
    }
  }

  return MakeIdleSuccessEnvelope(
      status, status_text, body, content_type,
      idle_completed || (is_sync_stream && !body.empty()));
}

}  // namespace

std::shared_ptr<PlatformStreamTask> StartPlatformStreamingRequest(
    const HttpRequest& request, PlatformStreamCallbacks callbacks) {
  auto task =
      std::make_shared<WinHttpStreamTask>(request, std::move(callbacks));
  task->Start();
  return task;
}

void StartPlatformIdleCompleteRequest(const HttpRequest& request,
                                      bool is_sync_stream,
                                      EnvelopeCallback callback) {
  if (!callback) {
    return;
  }
  std::thread([request, is_sync_stream,
               callback = std::move(callback)]() mutable {
    callback(RunWinHttpIdleComplete(request, is_sync_stream));
  }).detach();
}

}  // namespace ps_desktop_http

#endif  // defined(_WIN32)
