#include "sync_http_policy.h"
#include "sync_http_session.h"

#include <jni.h>

namespace {

ps_sync_http_session* session_from(jlong handle) {
  if (handle == 0) {
    return nullptr;
  }
  return reinterpret_cast<ps_sync_http_session*>(handle);
}

class ScopedUtfChars {
 public:
  ScopedUtfChars(JNIEnv* env, jstring str) : env_(env), str_(str) {
    if (str_ != nullptr) {
      chars_ = env_->GetStringUTFChars(str_, nullptr);
    }
  }

  ~ScopedUtfChars() {
    if (chars_ != nullptr) {
      env_->ReleaseStringUTFChars(str_, chars_);
    }
  }

  ScopedUtfChars(const ScopedUtfChars&) = delete;
  ScopedUtfChars& operator=(const ScopedUtfChars&) = delete;

  const char* c_str() const { return chars_; }

 private:
  JNIEnv* env_;
  jstring str_;
  const char* chars_ = nullptr;
};

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeCreate(JNIEnv*, jclass) {
  return reinterpret_cast<jlong>(new ps_sync_http_session());
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeDestroy(JNIEnv*, jclass, jlong handle) {
  delete session_from(handle);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeRoute(JNIEnv*, jclass, jboolean syncStreamUrl,
                                                    jboolean hasEventSender) {
  return ps_sync_http_route(syncStreamUrl == JNI_TRUE ? 1 : 0,
                            hasEventSender == JNI_TRUE ? 1 : 0);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeIsSyncStreamUrl(JNIEnv* env, jclass, jstring url) {
  ScopedUtfChars url_utf(env, url);
  return ps_sync_http_is_sync_stream_url(url_utf.c_str()) != 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeLooksLikeLongLived(JNIEnv* env, jclass,
                                                                 jstring transferEncoding,
                                                                 jstring contentLength,
                                                                 jstring contentType) {
  ScopedUtfChars encoding_utf(env, transferEncoding);
  ScopedUtfChars length_utf(env, contentLength);
  ScopedUtfChars type_utf(env, contentType);
  return ps_sync_http_looks_like_long_lived(encoding_utf.c_str(), length_utf.c_str(),
                                            type_utf.c_str()) != 0
             ? JNI_TRUE
             : JNI_FALSE;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnHeaders(JNIEnv*, jclass, jlong handle) {
  return ps_sync_http_session_on_headers(session_from(handle));
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnData(JNIEnv*, jclass, jlong handle) {
  return ps_sync_http_session_on_data(session_from(handle));
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnEnd(JNIEnv*, jclass, jlong handle) {
  return ps_sync_http_session_on_end(session_from(handle));
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnError(JNIEnv*, jclass, jlong handle) {
  return ps_sync_http_session_on_error(session_from(handle));
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeAbort(JNIEnv*, jclass, jlong handle) {
  return ps_sync_http_session_abort(session_from(handle));
}
