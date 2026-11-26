#ifndef POWERSYNC_LYNX_CORE_PATH_H_
#define POWERSYNC_LYNX_CORE_PATH_H_

#include <functional>
#include <string>

namespace ps_sql {

enum class CorePlatform { kMacOS, kWindows, kLinux };

struct CorePathOptions {
  CorePlatform platform = CorePlatform::kMacOS;
  std::string env_core_path;
  std::string module_dir;
  std::string core_filename;
  std::function<bool(const std::string&)> file_exists;
};

// Resolves the powersync-sqlite-core dynamic library path:
// 1. If env_core_path (POWERSYNC_CORE_PATH) is set and non-empty, return it.
// 2. On macOS, probe <module_dir>/<core_filename> first, then
//    <module_dir>/../Frameworks/<core_filename> (checking file existence
//    before falling back).
// 3. On Windows/other, return <module_dir>\<core_filename> (or / on POSIX).
inline std::string ResolveCorePath(const CorePathOptions& options) {
  if (!options.env_core_path.empty()) {
    return options.env_core_path;
  }

  const std::string sep =
      options.platform == CorePlatform::kWindows ? "\\" : "/";
  auto join = [&](const std::string& base, const std::string& rel) {
    if (base.empty()) {
      return rel;
    }
    if (base.back() == '/' || base.back() == '\\') {
      return base + rel;
    }
    return base + sep + rel;
  };

  const std::string sibling = join(options.module_dir, options.core_filename);
  if (options.platform == CorePlatform::kMacOS) {
    if (options.file_exists && options.file_exists(sibling)) {
      return sibling;
    }
    const std::string frameworks =
        join(join(join(options.module_dir, ".."), "Frameworks"),
             options.core_filename);
    if (options.file_exists && options.file_exists(frameworks)) {
      return frameworks;
    }
    return sibling;
  }

  return sibling;
}

}  // namespace ps_sql

#endif
