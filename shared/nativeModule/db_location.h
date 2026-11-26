#ifndef POWERSYNC_LYNX_DB_LOCATION_H_
#define POWERSYNC_LYNX_DB_LOCATION_H_

#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

#if defined(_WIN32)
#include "win_utf8.h"
#include <knownfolders.h>
#include <shlobj.h>
#else
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <mach-o/dyld.h>
#endif
#endif

namespace ps_sql {

enum class DbLocationPlatform { kMacOS, kWindows, kLinux };

inline DbLocationPlatform CurrentDbLocationPlatform() {
#if defined(_WIN32)
  return DbLocationPlatform::kWindows;
#elif defined(__APPLE__)
  return DbLocationPlatform::kMacOS;
#else
  return DbLocationPlatform::kLinux;
#endif
}

inline bool IsAbsoluteDbPath(const std::string& path,
                             DbLocationPlatform platform) {
  if (path.empty()) {
    return false;
  }
  if (platform == DbLocationPlatform::kWindows) {
    if (path[0] == '\\' || path[0] == '/') {
      return true;
    }
    return path.size() >= 2 &&
           std::isalpha(static_cast<unsigned char>(path[0])) != 0 &&
           path[1] == ':';
  }
  return path[0] == '/';
}

inline bool NeedsDefaultDbLocation(const std::string& db_filename,
                                   DbLocationPlatform platform) {
  if (db_filename.empty() || db_filename == ":memory:" ||
      db_filename.rfind("file:", 0) == 0) {
    return false;
  }
  return !IsAbsoluteDbPath(db_filename, platform);
}

inline std::string SanitizeAppName(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (unsigned char ch : raw) {
    if (ch < 0x20 || ch == '/' || ch == '\\' || ch == ':' || ch == '*' ||
        ch == '?' || ch == '"' || ch == '<' || ch == '>' || ch == '|') {
      out.push_back('_');
    } else {
      out.push_back(static_cast<char>(ch));
    }
  }
  std::size_t start = 0;
  while (start < out.size() &&
         std::isspace(static_cast<unsigned char>(out[start])) != 0) {
    ++start;
  }
  std::size_t end = out.size();
  while (end > start &&
         (std::isspace(static_cast<unsigned char>(out[end - 1])) != 0 ||
          out[end - 1] == '.')) {
    --end;
  }
  out = out.substr(start, end - start);
  if (out.empty() || out == "." || out == "..") {
    return {};
  }
  return out;
}

struct DefaultDbLocationOptions {
  DbLocationPlatform platform = DbLocationPlatform::kMacOS;
  // macOS: home directory ($HOME); appends /Library/Application Support/<app>
  // Windows: %LOCALAPPDATA% directory; appends \<app>
  // Linux: XDG data directory ($XDG_DATA_HOME or $HOME/.local/share); appends /<app>
  std::string base_dir;
  // macOS CFBundleIdentifier (ignored on other platforms)
  std::string bundle_id;
  // Current executable basename (macOS/Linux) or stem (Windows)
  std::string executable_name;
};

inline std::string ResolveDefaultDbLocation(
    const DefaultDbLocationOptions& options) {
  if (options.base_dir.empty()) {
    return {};
  }
  const std::string sep =
      options.platform == DbLocationPlatform::kWindows ? "\\" : "/";
  auto join = [&](const std::string& a, const std::string& b) {
    if (a.empty()) {
      return b;
    }
    if (a.back() == '/' || a.back() == '\\') {
      return a + b;
    }
    return a + sep + b;
  };

  std::string app;
  if (options.platform == DbLocationPlatform::kMacOS) {
    app = SanitizeAppName(options.bundle_id);
  }
  if (app.empty()) {
    app = SanitizeAppName(options.executable_name);
  }
  if (app.empty()) {
    app = "powersync-lynx";
  }

  if (options.platform == DbLocationPlatform::kMacOS) {
    return join(join(join(options.base_dir, "Library"), "Application Support"),
                app);
  }
  return join(options.base_dir, app);
}

inline bool EnsureDirectoryRecursive(const std::string& path,
                                     std::string* error_out) {
  auto set_error = [&](const std::string& msg) {
    if (error_out != nullptr) {
      *error_out = msg;
    }
  };
  if (path.empty()) {
    set_error("default dbLocation path is empty");
    return false;
  }

#if defined(_WIN32)
  std::wstring wide = Utf8ToWide(path);
  if (wide.empty()) {
    set_error("default dbLocation is not valid UTF-8");
    return false;
  }
  while (wide.size() > 1 && (wide.back() == L'\\' || wide.back() == L'/')) {
    if (wide.size() == 3 && wide[1] == L':') {
      break;
    }
    wide.pop_back();
  }

  auto is_dir_wide = [](const std::wstring& w) {
    const DWORD attrs = GetFileAttributesW(w.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES &&
           (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
  };

  const DWORD existing = GetFileAttributesW(wide.c_str());
  if (existing != INVALID_FILE_ATTRIBUTES) {
    if ((existing & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      return true;
    }
    set_error("default dbLocation exists and is not a directory: " + path);
    return false;
  }

  std::size_t pos = 0;
  if (wide.size() >= 3 && wide[1] == L':' &&
      (wide[2] == L'\\' || wide[2] == L'/')) {
    pos = 3;
  } else if (wide.size() >= 2 &&
             (wide[0] == L'\\' || wide[0] == L'/') &&
             (wide[1] == L'\\' || wide[1] == L'/')) {
    // Skip \\server\share prefix
    pos = 2;
    int skipped = 0;
    while (pos < wide.size() && skipped < 2) {
      if (wide[pos] == L'\\' || wide[pos] == L'/') {
        ++skipped;
      }
      ++pos;
    }
  } else if (!wide.empty() && (wide[0] == L'\\' || wide[0] == L'/')) {
    pos = 1;
  }

  for (std::size_t i = pos; i < wide.size(); ++i) {
    if (wide[i] == L'\\' || wide[i] == L'/') {
      if (i > pos) {
        std::wstring prefix = wide.substr(0, i);
        if (!CreateDirectoryW(prefix.c_str(), nullptr)) {
          const DWORD err = GetLastError();
          if (err == ERROR_ALREADY_EXISTS) {
            if (!is_dir_wide(prefix)) {
              set_error("default dbLocation parent is not a directory: " +
                        WideToUtf8(prefix.c_str(),
                                   static_cast<int>(prefix.size())));
              return false;
            }
          } else {
            set_error("failed to create default dbLocation (Win32 error " +
                      std::to_string(err) + "): " + path);
            return false;
          }
        }
      }
      pos = i + 1;
    }
  }

  if (!CreateDirectoryW(wide.c_str(), nullptr)) {
    const DWORD err = GetLastError();
    if (err == ERROR_ALREADY_EXISTS && is_dir_wide(wide)) {
      return true;
    }
    set_error("failed to create default dbLocation (Win32 error " +
              std::to_string(err) + "): " + path);
    return false;
  }
  return true;
#else
  std::string norm = path;
  while (norm.size() > 1 && norm.back() == '/') {
    norm.pop_back();
  }

  auto is_dir_posix = [](const std::string& p) {
    struct stat st;
    return stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
  };

  struct stat st;
  if (stat(norm.c_str(), &st) == 0) {
    if (S_ISDIR(st.st_mode)) {
      return true;
    }
    set_error("default dbLocation exists and is not a directory: " + norm);
    return false;
  }

  std::size_t pos = norm[0] == '/' ? 1 : 0;
  for (std::size_t i = pos; i < norm.size(); ++i) {
    if (norm[i] == '/') {
      if (i > pos) {
        std::string prefix = norm.substr(0, i);
        if (mkdir(prefix.c_str(), 0755) != 0) {
          const int err = errno;
          if (err == EEXIST) {
            if (!is_dir_posix(prefix)) {
              set_error("default dbLocation parent is not a directory: " +
                        prefix);
              return false;
            }
          } else {
            set_error(std::string("failed to create default dbLocation: ") +
                      std::strerror(err));
            return false;
          }
        }
      }
      pos = i + 1;
    }
  }

  if (mkdir(norm.c_str(), 0755) != 0) {
    const int err = errno;
    if (err == EEXIST && is_dir_posix(norm)) {
      return true;
    }
    set_error(std::string("failed to create default dbLocation: ") +
              std::strerror(err));
    return false;
  }
  return true;
#endif
}

inline std::string CurrentBundleIdentifier() {
#if defined(__APPLE__)
  CFBundleRef bundle = CFBundleGetMainBundle();
  if (bundle == nullptr) {
    return {};
  }
  CFStringRef id = CFBundleGetIdentifier(bundle);
  if (id == nullptr) {
    return {};
  }
  const CFIndex len = CFStringGetLength(id);
  if (len <= 0) {
    return {};
  }
  const CFIndex max_size =
      CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
  std::string buf(static_cast<std::size_t>(max_size), '\0');
  if (!CFStringGetCString(id, &buf[0], max_size, kCFStringEncodingUTF8)) {
    return {};
  }
  buf.resize(std::strlen(buf.c_str()));
  return buf;
#else
  return {};
#endif
}

inline std::string CurrentExecutableName() {
#if defined(_WIN32)
  const std::string full = GetModuleFilePathUtf8(nullptr);
  if (full.empty()) {
    return {};
  }
  const auto slash = full.find_last_of("\\/");
  std::string name =
      slash == std::string::npos ? full : full.substr(slash + 1);
  const auto dot = name.find_last_of('.');
  if (dot != std::string::npos && dot > 0) {
    name.resize(dot);
  }
  return name;
#elif defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  if (size == 0) {
    return {};
  }
  std::string full(size, '\0');
  if (_NSGetExecutablePath(&full[0], &size) != 0) {
    return {};
  }
  full.resize(std::strlen(full.c_str()));
  const auto slash = full.find_last_of('/');
  return slash == std::string::npos ? full : full.substr(slash + 1);
#else
  std::string full(4096, '\0');
  const ssize_t n = readlink("/proc/self/exe", &full[0], full.size() - 1);
  if (n <= 0) {
    return {};
  }
  full.resize(static_cast<std::size_t>(n));
  const auto slash = full.find_last_of('/');
  return slash == std::string::npos ? full : full.substr(slash + 1);
#endif
}

inline std::string CurrentAppDataBaseDir() {
#if defined(_WIN32)
  PWSTR wide_path = nullptr;
  const HRESULT hr =
      SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &wide_path);
  if (SUCCEEDED(hr) && wide_path != nullptr) {
    std::string utf8 = WideToUtf8(wide_path);
    CoTaskMemFree(wide_path);
    if (!utf8.empty()) {
      return utf8;
    }
  } else if (wide_path != nullptr) {
    CoTaskMemFree(wide_path);
  }
  return ReadEnvVarUtf8(L"LOCALAPPDATA");
#elif defined(__APPLE__)
  const char* home = std::getenv("HOME");
  if (home != nullptr && home[0] != '\0') {
    return std::string(home);
  }
  struct passwd* pw = getpwuid(getuid());
  if (pw != nullptr && pw->pw_dir != nullptr && pw->pw_dir[0] != '\0') {
    return std::string(pw->pw_dir);
  }
  return {};
#else
  const char* xdg = std::getenv("XDG_DATA_HOME");
  if (xdg != nullptr && xdg[0] != '\0') {
    return std::string(xdg);
  }
  const char* home = std::getenv("HOME");
  std::string home_dir;
  if (home != nullptr && home[0] != '\0') {
    home_dir = home;
  } else {
    struct passwd* pw = getpwuid(getuid());
    if (pw != nullptr && pw->pw_dir != nullptr && pw->pw_dir[0] != '\0') {
      home_dir = pw->pw_dir;
    }
  }
  if (home_dir.empty()) {
    return {};
  }
  if (home_dir.back() == '/') {
    return home_dir + ".local/share";
  }
  return home_dir + "/.local/share";
#endif
}

inline std::string ResolveAndCreateDefaultDbLocation(
    std::string* error_out,
    const DefaultDbLocationOptions* override_options = nullptr) {
  DefaultDbLocationOptions options;
  if (override_options != nullptr) {
    options = *override_options;
  } else {
    options.platform = CurrentDbLocationPlatform();
    options.base_dir = CurrentAppDataBaseDir();
    options.bundle_id = CurrentBundleIdentifier();
    options.executable_name = CurrentExecutableName();
  }
  const std::string resolved = ResolveDefaultDbLocation(options);
  if (resolved.empty()) {
    if (error_out != nullptr) {
      *error_out = "failed to resolve default app-data dbLocation";
    }
    return {};
  }
  if (!EnsureDirectoryRecursive(resolved, error_out)) {
    return {};
  }
  return resolved;
}

}  // namespace ps_sql

#endif  // POWERSYNC_LYNX_DB_LOCATION_H_
