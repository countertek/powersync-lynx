#ifndef POWERSYNC_LYNX_IOS_BIND_H_
#define POWERSYNC_LYNX_IOS_BIND_H_

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string_view>

namespace lynx_ios_bind {

constexpr std::int64_t kMaxSafeInteger = 9007199254740991LL;

inline bool CanonicalInt64(std::string_view text, std::int64_t* out) {
  if (text.empty() || text.size() >= 32) {
    return false;
  }
  char buf[32];
  std::memcpy(buf, text.data(), text.size());
  buf[text.size()] = '\0';
  errno = 0;
  char* end = nullptr;
  const long long parsed = std::strtoll(buf, &end, 10);
  if (errno == ERANGE || end == buf || *end != '\0') {
    return false;
  }
  char canonical[32];
  if (std::snprintf(canonical, sizeof(canonical), "%lld", parsed) <= 0 ||
      std::strcmp(canonical, buf) != 0) {
    return false;
  }
  *out = static_cast<std::int64_t>(parsed);
  return true;
}

inline bool IntegerFromLynxBigIntString(std::string_view text,
                                        std::int64_t* out) {
  if (!CanonicalInt64(text, out)) {
    return false;
  }
  return *out > kMaxSafeInteger || *out < -kMaxSafeInteger;
}

}  // namespace lynx_ios_bind

#endif
