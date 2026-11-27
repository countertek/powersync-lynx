#include "sync_http_policy.h"
#include "sync_http/sync_http_session.h"

#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

namespace {

ps_sync_http::SyncHttpStreamSession* session_from(jlong handle) {
  if (handle == 0) {
    return nullptr;
  }
  return reinterpret_cast<ps_sync_http::SyncHttpStreamSession*>(handle);
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

// Convert standard UTF-8 (including 4-byte supplementary code points) to a
// Java String via UTF-16 so ART never rejects 4-byte sequences under Modified UTF-8.
jstring NewJavaStringFromUtf8(JNIEnv* env, const std::string& utf8) {
  if (env == nullptr) {
    return nullptr;
  }
  std::vector<jchar> u16;
  u16.reserve(utf8.size());
  const auto* bytes = reinterpret_cast<const uint8_t*>(utf8.data());
  const size_t len = utf8.size();
  size_t i = 0;
  while (i < len) {
    const uint8_t b0 = bytes[i];
    if (b0 < 0x80u) {
      u16.push_back(static_cast<jchar>(b0));
      i += 1;
    } else if ((b0 & 0xe0u) == 0xc0u && i + 1 < len && (bytes[i + 1] & 0xc0u) == 0x80u) {
      const uint32_t cp =
          ((static_cast<uint32_t>(b0 & 0x1fu)) << 6) | static_cast<uint32_t>(bytes[i + 1] & 0x3fu);
      if (cp >= 0x80u) {
        u16.push_back(static_cast<jchar>(cp));
      } else {
        u16.push_back(0xfffdu);
      }
      i += 2;
    } else if ((b0 & 0xf0u) == 0xe0u && i + 2 < len && (bytes[i + 1] & 0xc0u) == 0x80u &&
               (bytes[i + 2] & 0xc0u) == 0x80u) {
      const uint32_t cp = ((static_cast<uint32_t>(b0 & 0x0fu)) << 12) |
                          ((static_cast<uint32_t>(bytes[i + 1] & 0x3fu)) << 6) |
                          static_cast<uint32_t>(bytes[i + 2] & 0x3fu);
      if (cp >= 0x800u && (cp < 0xd800u || cp > 0xdfffu)) {
        u16.push_back(static_cast<jchar>(cp));
      } else {
        u16.push_back(0xfffdu);
      }
      i += 3;
    } else if ((b0 & 0xf8u) == 0xf0u && i + 3 < len && (bytes[i + 1] & 0xc0u) == 0x80u &&
               (bytes[i + 2] & 0xc0u) == 0x80u && (bytes[i + 3] & 0xc0u) == 0x80u) {
      const uint32_t cp = ((static_cast<uint32_t>(b0 & 0x07u)) << 18) |
                          ((static_cast<uint32_t>(bytes[i + 1] & 0x3fu)) << 12) |
                          ((static_cast<uint32_t>(bytes[i + 2] & 0x3fu)) << 6) |
                          static_cast<uint32_t>(bytes[i + 3] & 0x3fu);
      if (cp >= 0x10000u && cp <= 0x10ffffu) {
        const uint32_t v = cp - 0x10000u;
        u16.push_back(static_cast<jchar>(0xd800u + (v >> 10)));
        u16.push_back(static_cast<jchar>(0xdc00u + (v & 0x3ffu)));
      } else {
        u16.push_back(0xfffdu);
      }
      i += 4;
    } else {
      u16.push_back(0xfffdu);
      i += 1;
    }
  }
  return env->NewString(u16.empty() ? nullptr : u16.data(), static_cast<jsize>(u16.size()));
}

class JniStreamSink final : public ps_sync_http::StreamSessionSink {
 public:
  JniStreamSink(JNIEnv* env, jobject sink) : env_(env), sink_(sink) {
    if (env_ == nullptr || sink_ == nullptr) {
      return;
    }
    cls_ = env_->GetObjectClass(sink_);
    if (cls_ == nullptr) {
      return;
    }
    on_headers_ =
        env_->GetMethodID(cls_, "onHeaders", "(ILjava/lang/String;Ljava/lang/String;)V");
    on_fail_ = env_->GetMethodID(cls_, "onFail", "(Ljava/lang/String;)V");
    on_data_ = env_->GetMethodID(cls_, "onData", "(Ljava/lang/String;)V");
    on_error_ = env_->GetMethodID(cls_, "onError", "(Ljava/lang/String;)V");
    on_end_ = env_->GetMethodID(cls_, "onEnd", "()V");
    cancel_io_ = env_->GetMethodID(cls_, "cancelIo", "()V");
    on_drop_ = env_->GetMethodID(cls_, "onDrop", "()V");
  }

  ~JniStreamSink() override {
    if (env_ != nullptr && cls_ != nullptr) {
      env_->DeleteLocalRef(cls_);
    }
  }

  void OnHeaders(int status, const std::string& status_text,
                 const std::string& content_type) override {
    if (!Ready(on_headers_)) {
      return;
    }
    jstring jstatus_text = NewJavaStringFromUtf8(env_, status_text);
    jstring jcontent_type =
        content_type.empty() ? nullptr : NewJavaStringFromUtf8(env_, content_type);
    env_->CallVoidMethod(sink_, on_headers_, static_cast<jint>(status), jstatus_text,
                         jcontent_type);
    if (jstatus_text != nullptr) {
      env_->DeleteLocalRef(jstatus_text);
    }
    if (jcontent_type != nullptr) {
      env_->DeleteLocalRef(jcontent_type);
    }
  }

  void OnFail(const std::string& message) override {
    if (!Ready(on_fail_)) {
      return;
    }
    jstring jmsg = NewJavaStringFromUtf8(env_, message);
    env_->CallVoidMethod(sink_, on_fail_, jmsg);
    if (jmsg != nullptr) {
      env_->DeleteLocalRef(jmsg);
    }
  }

  void OnData(const std::string& utf8_chunk) override {
    if (!Ready(on_data_)) {
      return;
    }
    jstring jchunk = NewJavaStringFromUtf8(env_, utf8_chunk);
    env_->CallVoidMethod(sink_, on_data_, jchunk);
    if (jchunk != nullptr) {
      env_->DeleteLocalRef(jchunk);
    }
  }

  void OnError(const std::string& message) override {
    if (!Ready(on_error_)) {
      return;
    }
    jstring jmsg = NewJavaStringFromUtf8(env_, message);
    env_->CallVoidMethod(sink_, on_error_, jmsg);
    if (jmsg != nullptr) {
      env_->DeleteLocalRef(jmsg);
    }
  }

  void OnEnd() override {
    if (!Ready(on_end_)) {
      return;
    }
    env_->CallVoidMethod(sink_, on_end_);
  }

  void CancelIo() override {
    if (!Ready(cancel_io_)) {
      return;
    }
    env_->CallVoidMethod(sink_, cancel_io_);
  }

  void OnDrop() override {
    if (!Ready(on_drop_)) {
      return;
    }
    env_->CallVoidMethod(sink_, on_drop_);
  }

 private:
  bool Ready(jmethodID method) const {
    return env_ != nullptr && sink_ != nullptr && method != nullptr && !env_->ExceptionCheck();
  }

  JNIEnv* env_;
  jobject sink_;
  jclass cls_ = nullptr;
  jmethodID on_headers_ = nullptr;
  jmethodID on_fail_ = nullptr;
  jmethodID on_data_ = nullptr;
  jmethodID on_error_ = nullptr;
  jmethodID on_end_ = nullptr;
  jmethodID cancel_io_ = nullptr;
  jmethodID on_drop_ = nullptr;
};

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeCreate(JNIEnv*, jclass) {
  return reinterpret_cast<jlong>(new ps_sync_http::SyncHttpStreamSession());
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeDestroy(JNIEnv*, jclass, jlong handle) {
  delete session_from(handle);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeRoute(JNIEnv*, jclass, jboolean syncStreamUrl,
                                                    jboolean hasEventSender) {
  return ps_sync_http::Route(syncStreamUrl == JNI_TRUE, hasEventSender == JNI_TRUE);
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

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnHeaders(JNIEnv* env, jclass, jlong handle,
                                                        jint status, jstring statusText,
                                                        jstring contentType, jobject sinkObj) {
  auto* session = session_from(handle);
  if (session == nullptr || sinkObj == nullptr) {
    return;
  }
  ScopedUtfChars status_utf(env, statusText);
  ScopedUtfChars ct_utf(env, contentType);
  JniStreamSink sink(env, sinkObj);
  session->OnHeaders(static_cast<int>(status),
                     status_utf.c_str() != nullptr ? status_utf.c_str() : "",
                     ct_utf.c_str() != nullptr ? ct_utf.c_str() : "", sink);
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnBytes(JNIEnv* env, jclass, jlong handle,
                                                      jbyteArray bytes, jint offset, jint length,
                                                      jobject sinkObj) {
  auto* session = session_from(handle);
  if (session == nullptr || bytes == nullptr || sinkObj == nullptr || offset < 0 || length <= 0) {
    return;
  }
  const jsize array_len = env->GetArrayLength(bytes);
  if (offset > array_len || length > array_len - offset) {
    return;
  }
  std::vector<uint8_t> copy(static_cast<size_t>(length));
  env->GetByteArrayRegion(bytes, offset, length, reinterpret_cast<jbyte*>(copy.data()));
  if (env->ExceptionCheck()) {
    return;
  }
  JniStreamSink sink(env, sinkObj);
  session->OnBytes(copy.data(), copy.size(), sink);
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnEnd(JNIEnv* env, jclass, jlong handle,
                                                    jobject sinkObj) {
  auto* session = session_from(handle);
  if (session == nullptr || sinkObj == nullptr) {
    return;
  }
  JniStreamSink sink(env, sinkObj);
  session->OnEnd(sink);
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeOnError(JNIEnv* env, jclass, jlong handle,
                                                      jstring message, jobject sinkObj) {
  auto* session = session_from(handle);
  if (session == nullptr || sinkObj == nullptr) {
    return;
  }
  ScopedUtfChars msg_utf(env, message);
  JniStreamSink sink(env, sinkObj);
  session->OnError(msg_utf.c_str() != nullptr ? msg_utf.c_str() : "", sink);
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeAbort(JNIEnv* env, jclass, jlong handle,
                                                    jobject sinkObj) {
  auto* session = session_from(handle);
  if (session == nullptr || sinkObj == nullptr) {
    return;
  }
  JniStreamSink sink(env, sinkObj);
  session->Abort(sink);
}
