#include "ShowcaseHttpService.h"

#include <windows.h>
#include <winhttp.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "win_utf8.h"

namespace {

class WinHttpHandle {
 public:
  explicit WinHttpHandle(HINTERNET handle = nullptr) : handle_(handle) {}
  ~WinHttpHandle() { Reset(); }

  WinHttpHandle(const WinHttpHandle&) = delete;
  WinHttpHandle& operator=(const WinHttpHandle&) = delete;

  void Reset(HINTERNET next = nullptr) {
    if (handle_ != nullptr) {
      WinHttpCloseHandle(handle_);
    }
    handle_ = next;
  }

  HINTERNET get() const { return handle_; }
  explicit operator bool() const { return handle_ != nullptr; }

 private:
  HINTERNET handle_;
};

std::string TrimAscii(const std::string& s) {
  size_t start = 0;
  while (start < s.size() &&
         (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' ||
          s[start] == '\n')) {
    ++start;
  }
  size_t end = s.size();
  while (end > start &&
         (s[end - 1] == ' ' || s[end - 1] == '\t' || s[end - 1] == '\r' ||
          s[end - 1] == '\n')) {
    --end;
  }
  return s.substr(start, end - start);
}

void FailResponse(const std::shared_ptr<lynx::pub::LynxHttpResponse>& response,
                  const std::string& method,
                  const std::string& url,
                  const std::string& reason,
                  DWORD win_err = 0) {
  std::string message = reason;
  if (win_err != 0) {
    message += " (WinHTTP error " + std::to_string(win_err) + ")";
  }
  std::fprintf(stderr, "[ShowcaseHttpService] <- %s %s ERROR: %s\n",
               method.c_str(), url.c_str(), message.c_str());
  std::fflush(stderr);
  response->SetStatusCode(-1);
  response->SetStatusText(message.c_str());
  response->Complete();
}

void ExecuteWinHttpRequest(
    const std::shared_ptr<lynx::pub::LynxHttpRequest>& request,
    const std::shared_ptr<lynx::pub::LynxHttpResponse>& response,
    const std::shared_ptr<std::atomic<bool>>& alive) {
  if (!alive->load()) {
    response->SetStatusCode(-1);
    response->SetStatusText("HTTP service shut down");
    response->Complete();
    return;
  }

  const std::string url = request->GetUrl();
  const std::string method =
      request->GetMethod().empty() ? "GET" : request->GetMethod();
  const auto& body = request->GetBody();

  std::fprintf(stderr, "[ShowcaseHttpService] -> %s %s (%zu body bytes)\n",
               method.c_str(), url.c_str(), body.size());
  std::fflush(stderr);

  std::wstring wide_url = ps_sql::Utf8ToWide(url);
  if (wide_url.empty()) {
    FailResponse(response, method, url, "Invalid UTF-8 URL");
    return;
  }

  URL_COMPONENTSW components{};
  components.dwStructSize = sizeof(components);
  components.dwSchemeLength = static_cast<DWORD>(-1);
  components.dwHostNameLength = static_cast<DWORD>(-1);
  components.dwUrlPathLength = static_cast<DWORD>(-1);
  components.dwExtraInfoLength = static_cast<DWORD>(-1);

  if (!WinHttpCrackUrl(wide_url.c_str(),
                       static_cast<DWORD>(wide_url.size()), 0, &components)) {
    FailResponse(response, method, url, "WinHttpCrackUrl failed",
                 GetLastError());
    return;
  }

  std::wstring host(components.lpszHostName, components.dwHostNameLength);
  std::wstring path_and_query;
  if (components.dwUrlPathLength > 0) {
    path_and_query.assign(components.lpszUrlPath, components.dwUrlPathLength);
  } else {
    path_and_query = L"/";
  }
  if (components.dwExtraInfoLength > 0) {
    path_and_query.append(components.lpszExtraInfo,
                          components.dwExtraInfoLength);
  }

  WinHttpHandle session(WinHttpOpen(L"PowerSyncLynxShowcase/0.3.0",
                                    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                    WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0));
  if (!session) {
    session.Reset(WinHttpOpen(L"PowerSyncLynxShowcase/0.3.0",
                              WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                              WINHTTP_NO_PROXY_NAME,
                              WINHTTP_NO_PROXY_BYPASS, 0));
  }
  if (!session) {
    FailResponse(response, method, url, "WinHttpOpen failed", GetLastError());
    return;
  }

  WinHttpSetTimeouts(session.get(), 15000, 15000, 30000, 60000);

  WinHttpHandle connect(
      WinHttpConnect(session.get(), host.c_str(), components.nPort, 0));
  if (!connect) {
    FailResponse(response, method, url, "WinHttpConnect failed",
                 GetLastError());
    return;
  }

  DWORD flags =
      (components.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
  std::wstring wide_method = ps_sql::Utf8ToWide(method);
  WinHttpHandle req(WinHttpOpenRequest(
      connect.get(), wide_method.c_str(), path_and_query.c_str(), nullptr,
      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
  if (!req) {
    FailResponse(response, method, url, "WinHttpOpenRequest failed",
                 GetLastError());
    return;
  }

  for (const auto& kv : request->GetHeaders()) {
    std::wstring line = ps_sql::Utf8ToWide(kv.first + ": " + kv.second);
    if (!line.empty()) {
      WinHttpAddRequestHeaders(
          req.get(), line.c_str(), static_cast<DWORD>(line.size()),
          WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
    }
  }

  LPVOID body_ptr =
      body.empty() ? WINHTTP_NO_REQUEST_DATA
                   : const_cast<uint8_t*>(body.data());
  DWORD body_len = static_cast<DWORD>(body.size());

  // NOTE: Lynx 4.2.0 Desktop C++ LynxHttpService / lynx_http_service_capi.h
  // exposes only a single buffered SetBody() + Complete() callback and no
  // request cancellation hook. Long-lived streaming responses (such as
  // PowerSync's /sync/stream NDJSON) cannot deliver incremental chunks before
  // connection close through this API.
  if (!WinHttpSendRequest(req.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, body_ptr,
                          body_len, body_len, 0)) {
    FailResponse(response, method, url, "WinHttpSendRequest failed",
                 GetLastError());
    return;
  }

  if (!WinHttpReceiveResponse(req.get(), nullptr)) {
    FailResponse(response, method, url, "WinHttpReceiveResponse failed",
                 GetLastError());
    return;
  }

  DWORD status_code = 0;
  DWORD status_size = sizeof(status_code);
  WinHttpQueryHeaders(
      req.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
      WINHTTP_HEADER_NAME_BY_INDEX, &status_code, &status_size,
      WINHTTP_NO_HEADER_INDEX);

  std::string status_text;
  DWORD text_bytes = 0;
  WinHttpQueryHeaders(req.get(), WINHTTP_QUERY_STATUS_TEXT,
                      WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &text_bytes,
                      WINHTTP_NO_HEADER_INDEX);
  if (GetLastError() == ERROR_INSUFFICIENT_BUFFER && text_bytes > 0) {
    std::wstring wide_text(text_bytes / sizeof(wchar_t), L'\0');
    if (WinHttpQueryHeaders(req.get(), WINHTTP_QUERY_STATUS_TEXT,
                            WINHTTP_HEADER_NAME_BY_INDEX, &wide_text[0],
                            &text_bytes, WINHTTP_NO_HEADER_INDEX)) {
      while (!wide_text.empty() && wide_text.back() == L'\0') {
        wide_text.pop_back();
      }
      status_text = ps_sql::WideToUtf8(wide_text);
    }
  }

  response->SetStatusCode(static_cast<int>(status_code));
  response->SetStatusText(status_text.c_str());

  DWORD raw_headers_bytes = 0;
  WinHttpQueryHeaders(req.get(), WINHTTP_QUERY_RAW_HEADERS_CRLF,
                      WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &raw_headers_bytes,
                      WINHTTP_NO_HEADER_INDEX);
  if (GetLastError() == ERROR_INSUFFICIENT_BUFFER && raw_headers_bytes > 0) {
    std::wstring wide_headers(raw_headers_bytes / sizeof(wchar_t), L'\0');
    if (WinHttpQueryHeaders(req.get(), WINHTTP_QUERY_RAW_HEADERS_CRLF,
                            WINHTTP_HEADER_NAME_BY_INDEX, &wide_headers[0],
                            &raw_headers_bytes, WINHTTP_NO_HEADER_INDEX)) {
      std::string headers_utf8 = ps_sql::WideToUtf8(wide_headers);
      size_t pos = 0;
      bool first_line = true;
      while (pos < headers_utf8.size()) {
        size_t eol = headers_utf8.find("\r\n", pos);
        std::string line = (eol == std::string::npos)
                               ? headers_utf8.substr(pos)
                               : headers_utf8.substr(pos, eol - pos);
        pos = (eol == std::string::npos) ? headers_utf8.size() : eol + 2;
        if (first_line) {
          first_line = false;
          continue;
        }
        size_t colon = line.find(':');
        if (colon == std::string::npos) {
          continue;
        }
        std::string key = TrimAscii(line.substr(0, colon));
        std::string val = TrimAscii(line.substr(colon + 1));
        if (!key.empty()) {
          response->AddHeader(key, val);
        }
      }
    }
  }

  std::vector<uint8_t> response_body;
  while (alive->load()) {
    DWORD available = 0;
    if (!WinHttpQueryDataAvailable(req.get(), &available)) {
      FailResponse(response, method, url, "WinHttpQueryDataAvailable failed",
                   GetLastError());
      return;
    }
    if (available == 0) {
      break;
    }
    size_t offset = response_body.size();
    response_body.resize(offset + available);
    DWORD bytes_read = 0;
    if (!WinHttpReadData(req.get(), response_body.data() + offset, available,
                         &bytes_read)) {
      FailResponse(response, method, url, "WinHttpReadData failed",
                   GetLastError());
      return;
    }
    response_body.resize(offset + bytes_read);
  }

  if (!response_body.empty()) {
    auto* buffer = new uint8_t[response_body.size()];
    std::memcpy(buffer, response_body.data(), response_body.size());
    response->SetBody(
        buffer, response_body.size(),
        [](uint8_t* ptr, size_t, void*) { delete[] ptr; }, nullptr);
  }

  std::fprintf(stderr, "[ShowcaseHttpService] <- %s %s HTTP %lu (%zu bytes)\n",
               method.c_str(), url.c_str(),
               static_cast<unsigned long>(status_code), response_body.size());
  std::fflush(stderr);
  response->Complete();
}

}  // namespace

ShowcaseHttpService::ShowcaseHttpService()
    : alive_(std::make_shared<std::atomic<bool>>(true)) {}

ShowcaseHttpService::~ShowcaseHttpService() {
  if (alive_) {
    alive_->store(false);
  }
}

void ShowcaseHttpService::Request(
    std::shared_ptr<lynx::pub::LynxHttpRequest> request,
    std::shared_ptr<lynx::pub::LynxHttpResponse> response) {
  if (!request || !response) {
    return;
  }
  auto alive = alive_;
  std::thread([request = std::move(request), response = std::move(response),
               alive = std::move(alive)]() {
    ExecuteWinHttpRequest(request, response, alive);
  }).detach();
}
