#include "utf8_hold.h"

#include <jni.h>

#include <cstdint>

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_StreamingHttp_trailingIncompleteUtf8Bytes(JNIEnv* env, jclass,
                                                                  jbyteArray bytes) {
  if (env == nullptr || bytes == nullptr) {
    return 0;
  }
  const jsize n = env->GetArrayLength(bytes);
  if (n <= 0) {
    return 0;
  }
  jbyte* raw = env->GetByteArrayElements(bytes, nullptr);
  if (raw == nullptr) {
    return 0;
  }
  const size_t hold = ps_utf8_trailing_incomplete(reinterpret_cast<const uint8_t*>(raw),
                                                  static_cast<size_t>(n));
  env->ReleaseByteArrayElements(bytes, raw, JNI_ABORT);
  if (hold > static_cast<size_t>(INT32_MAX)) {
    return 0;
  }
  return static_cast<jint>(hold);
}
