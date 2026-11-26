#ifndef POWERSYNC_LYNX_WIN_UTF8_H_
#define POWERSYNC_LYNX_WIN_UTF8_H_

#if defined(_WIN32)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <climits>
#include <cstdlib>
#include <cwchar>
#include <string>

namespace ps_sql {

inline std::wstring Utf8ToWide(const std::string& utf8) {
  if (utf8.empty() || utf8.size() > static_cast<std::size_t>(INT_MAX)) {
    return {};
  }
  const int needed = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()),
      nullptr, 0);
  if (needed <= 0) {
    return {};
  }
  std::wstring wide(static_cast<std::size_t>(needed), L'\0');
  const int written = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()),
      &wide[0], needed);
  if (written <= 0) {
    return {};
  }
  return wide;
}

inline std::string WideToUtf8(const wchar_t* wide, int len = -1) {
  if (wide == nullptr) {
    return {};
  }
  if (len < 0) {
    const std::size_t wlen = std::wcslen(wide);
    if (wlen == 0 || wlen > static_cast<std::size_t>(INT_MAX)) {
      return {};
    }
    len = static_cast<int>(wlen);
  }
  if (len == 0) {
    return {};
  }
  const int needed = WideCharToMultiByte(CP_UTF8, 0, wide, len, nullptr, 0,
                                         nullptr, nullptr);
  if (needed <= 0) {
    return {};
  }
  std::string utf8(static_cast<std::size_t>(needed), '\0');
  const int written = WideCharToMultiByte(CP_UTF8, 0, wide, len, &utf8[0],
                                          needed, nullptr, nullptr);
  if (written <= 0) {
    return {};
  }
  return utf8;
}

inline std::string WideToUtf8(const std::wstring& wide) {
  if (wide.empty() || wide.size() > static_cast<std::size_t>(INT_MAX)) {
    return {};
  }
  return WideToUtf8(wide.data(), static_cast<int>(wide.size()));
}

inline std::string GetModuleFilePathUtf8(HMODULE module) {
  constexpr std::size_t kMaxPathChars = 32768;
  std::size_t capacity = MAX_PATH;
  while (capacity <= kMaxPathChars) {
    std::wstring buf(capacity, L'\0');
    SetLastError(ERROR_SUCCESS);
    const DWORD n = GetModuleFileNameW(module, &buf[0],
                                       static_cast<DWORD>(buf.size()));
    if (n == 0) {
      return {};
    }
    if (n < buf.size() && GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
      return WideToUtf8(buf.data(), static_cast<int>(n));
    }
    if (capacity == kMaxPathChars) {
      break;
    }
    capacity = (capacity * 2 < kMaxPathChars) ? capacity * 2 : kMaxPathChars;
  }
  return {};
}

inline std::string ReadEnvVarUtf8(const wchar_t* name) {
  if (name == nullptr) {
    return {};
  }
#if defined(_MSC_VER)
  wchar_t* value = nullptr;
  std::size_t len = 0;
  if (_wdupenv_s(&value, &len, name) != 0 || value == nullptr) {
    return {};
  }
  std::string result = WideToUtf8(value);
  std::free(value);
  return result;
#else
  const wchar_t* value = _wgetenv(name);
  return value != nullptr ? WideToUtf8(value) : std::string();
#endif
}

}  // namespace ps_sql

#endif  // defined(_WIN32)

#endif  // POWERSYNC_LYNX_WIN_UTF8_H_
