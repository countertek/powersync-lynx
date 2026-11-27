#include "jni_runtime.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ps_jni {

namespace {

JavaVM* g_vm = nullptr;

}  // namespace

JavaVM* GetJavaVm() { return g_vm; }

jclass GlobalClass(JNIEnv* env, const char* name) {
  jclass local = env->FindClass(name);
  if (local == nullptr) {
    return nullptr;
  }
  jclass global = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  return global;
}

std::string JStringToUtf8(JNIEnv* env, jstring value) {
  if (env == nullptr || value == nullptr) {
    return {};
  }
  const jsize n = env->GetStringLength(value);
  if (n <= 0) {
    return {};
  }
  const jchar* chars = env->GetStringChars(value, nullptr);
  if (chars == nullptr) {
    return {};
  }
  std::string out;
  out.reserve(static_cast<std::size_t>(n));
  for (jsize i = 0; i < n;) {
    std::uint32_t cp = chars[i++];
    if (cp >= 0xD800u && cp <= 0xDBFFu && i < n) {
      const std::uint32_t low = chars[i];
      if (low >= 0xDC00u && low <= 0xDFFFu) {
        cp = 0x10000u + ((cp - 0xD800u) << 10) + (low - 0xDC00u);
        ++i;
      }
    }
    if (cp < 0x80u) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800u) {
      out.push_back(static_cast<char>(0xC0u | (cp >> 6)));
      out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    } else if (cp < 0x10000u) {
      out.push_back(static_cast<char>(0xE0u | (cp >> 12)));
      out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
      out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    } else {
      out.push_back(static_cast<char>(0xF0u | (cp >> 18)));
      out.push_back(static_cast<char>(0x80u | ((cp >> 12) & 0x3Fu)));
      out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
      out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    }
  }
  env->ReleaseStringChars(value, chars);
  return out;
}

jstring Utf8ToJString(JNIEnv* env, const std::string& utf8) {
  if (env == nullptr) {
    return nullptr;
  }
  std::vector<jchar> u16;
  u16.reserve(utf8.size());
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(utf8.data());
  const std::size_t len = utf8.size();
  std::size_t i = 0;
  while (i < len) {
    const std::uint8_t b0 = bytes[i];
    if (b0 < 0x80u) {
      u16.push_back(static_cast<jchar>(b0));
      i += 1;
    } else if ((b0 & 0xe0u) == 0xc0u && i + 1 < len &&
               (bytes[i + 1] & 0xc0u) == 0x80u) {
      const std::uint32_t cp =
          ((static_cast<std::uint32_t>(b0 & 0x1fu)) << 6) |
          static_cast<std::uint32_t>(bytes[i + 1] & 0x3fu);
      u16.push_back(cp >= 0x80u ? static_cast<jchar>(cp) : static_cast<jchar>(0xfffdu));
      i += 2;
    } else if ((b0 & 0xf0u) == 0xe0u && i + 2 < len &&
               (bytes[i + 1] & 0xc0u) == 0x80u &&
               (bytes[i + 2] & 0xc0u) == 0x80u) {
      const std::uint32_t cp =
          ((static_cast<std::uint32_t>(b0 & 0x0fu)) << 12) |
          ((static_cast<std::uint32_t>(bytes[i + 1] & 0x3fu)) << 6) |
          static_cast<std::uint32_t>(bytes[i + 2] & 0x3fu);
      if (cp >= 0x800u && (cp < 0xd800u || cp > 0xdfffu)) {
        u16.push_back(static_cast<jchar>(cp));
      } else {
        u16.push_back(static_cast<jchar>(0xfffdu));
      }
      i += 3;
    } else if ((b0 & 0xf8u) == 0xf0u && i + 3 < len &&
               (bytes[i + 1] & 0xc0u) == 0x80u &&
               (bytes[i + 2] & 0xc0u) == 0x80u &&
               (bytes[i + 3] & 0xc0u) == 0x80u) {
      const std::uint32_t cp =
          ((static_cast<std::uint32_t>(b0 & 0x07u)) << 18) |
          ((static_cast<std::uint32_t>(bytes[i + 1] & 0x3fu)) << 12) |
          ((static_cast<std::uint32_t>(bytes[i + 2] & 0x3fu)) << 6) |
          static_cast<std::uint32_t>(bytes[i + 3] & 0x3fu);
      if (cp >= 0x10000u && cp <= 0x10ffffu) {
        const std::uint32_t v = cp - 0x10000u;
        u16.push_back(static_cast<jchar>(0xd800u + (v >> 10)));
        u16.push_back(static_cast<jchar>(0xdc00u + (v & 0x3ffu)));
      } else {
        u16.push_back(static_cast<jchar>(0xfffdu));
      }
      i += 4;
    } else {
      u16.push_back(static_cast<jchar>(0xfffdu));
      i += 1;
    }
  }
  return env->NewString(u16.empty() ? nullptr : u16.data(),
                        static_cast<jsize>(u16.size()));
}

}  // namespace ps_jni

namespace ps_jni {

void SetJavaVm(JavaVM* vm) { g_vm = vm; }

}  // namespace ps_jni

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  ps_jni::SetJavaVm(vm);
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return JNI_ERR;
  }
  if (!ps_jni::InitPsSqlJni(env) || !ps_jni::InitSyncHttpSessionJni(env)) {
    return JNI_ERR;
  }
  return JNI_VERSION_1_6;
}
