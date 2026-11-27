#include "jni_runtime.h"
#include "sync_http_policy.h"
#include "sync_http/sync_http_session.h"

#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

namespace {

using ps_jni::GlobalClass;
using ps_jni::JStringToUtf8;
using ps_jni::Utf8ToJString;

jclass g_sink_cls = nullptr;
jmethodID g_sink_on_headers = nullptr;
jmethodID g_sink_on_fail = nullptr;
jmethodID g_sink_on_data = nullptr;
jmethodID g_sink_on_error = nullptr;
jmethodID g_sink_on_end = nullptr;
jmethodID g_sink_cancel_io = nullptr;
jmethodID g_sink_on_drop = nullptr;

ps_sync_http::SyncHttpStreamSession* session_from(jlong handle) {
  if (handle == 0) {
    return nullptr;
  }
  return reinterpret_cast<ps_sync_http::SyncHttpStreamSession*>(handle);
}

class JniStreamSink final : public ps_sync_http::StreamSessionSink {
 public:
  JniStreamSink(JNIEnv* env, jobject sink) : env_(env), sink_(sink) {}

  void OnHeaders(int status, const std::string& status_text,
                 const std::string& content_type) override {
    if (!Ready(g_sink_on_headers)) {
      return;
    }
    jstring jstatus_text = Utf8ToJString(env_, status_text);
    jstring jcontent_type =
        content_type.empty() ? nullptr : Utf8ToJString(env_, content_type);
    env_->CallVoidMethod(sink_, g_sink_on_headers, static_cast<jint>(status),
                         jstatus_text, jcontent_type);
    if (jstatus_text != nullptr) {
      env_->DeleteLocalRef(jstatus_text);
    }
    if (jcontent_type != nullptr) {
      env_->DeleteLocalRef(jcontent_type);
    }
  }

  void OnFail(const std::string& message) override {
    if (!Ready(g_sink_on_fail)) {
      return;
    }
    jstring jmsg = Utf8ToJString(env_, message);
    env_->CallVoidMethod(sink_, g_sink_on_fail, jmsg);
    if (jmsg != nullptr) {
      env_->DeleteLocalRef(jmsg);
    }
  }

  void OnData(const std::string& utf8_chunk) override {
    if (!Ready(g_sink_on_data)) {
      return;
    }
    jstring jchunk = Utf8ToJString(env_, utf8_chunk);
    env_->CallVoidMethod(sink_, g_sink_on_data, jchunk);
    if (jchunk != nullptr) {
      env_->DeleteLocalRef(jchunk);
    }
  }

  void OnError(const std::string& message) override {
    if (!Ready(g_sink_on_error)) {
      return;
    }
    jstring jmsg = Utf8ToJString(env_, message);
    env_->CallVoidMethod(sink_, g_sink_on_error, jmsg);
    if (jmsg != nullptr) {
      env_->DeleteLocalRef(jmsg);
    }
  }

  void OnEnd() override {
    if (!Ready(g_sink_on_end)) {
      return;
    }
    env_->CallVoidMethod(sink_, g_sink_on_end);
  }

  void CancelIo() override {
    if (!Ready(g_sink_cancel_io)) {
      return;
    }
    env_->CallVoidMethod(sink_, g_sink_cancel_io);
  }

  void OnDrop() override {
    if (!Ready(g_sink_on_drop)) {
      return;
    }
    env_->CallVoidMethod(sink_, g_sink_on_drop);
  }

 private:
  bool Ready(jmethodID method) const {
    return env_ != nullptr && sink_ != nullptr && method != nullptr &&
           !env_->ExceptionCheck();
  }

  JNIEnv* env_;
  jobject sink_;
};

}  // namespace

namespace ps_jni {

bool InitSyncHttpSessionJni(JNIEnv* env) {
  g_sink_cls = GlobalClass(env, "com/powersync/lynx/SyncHttpSession$Sink");
  if (g_sink_cls == nullptr) {
    return false;
  }
  g_sink_on_headers = env->GetMethodID(
      g_sink_cls, "onHeaders", "(ILjava/lang/String;Ljava/lang/String;)V");
  g_sink_on_fail = env->GetMethodID(g_sink_cls, "onFail", "(Ljava/lang/String;)V");
  g_sink_on_data = env->GetMethodID(g_sink_cls, "onData", "(Ljava/lang/String;)V");
  g_sink_on_error = env->GetMethodID(g_sink_cls, "onError", "(Ljava/lang/String;)V");
  g_sink_on_end = env->GetMethodID(g_sink_cls, "onEnd", "()V");
  g_sink_cancel_io = env->GetMethodID(g_sink_cls, "cancelIo", "()V");
  g_sink_on_drop = env->GetMethodID(g_sink_cls, "onDrop", "()V");
  return g_sink_on_headers != nullptr && g_sink_on_fail != nullptr &&
         g_sink_on_data != nullptr && g_sink_on_error != nullptr &&
         g_sink_on_end != nullptr && g_sink_cancel_io != nullptr &&
         g_sink_on_drop != nullptr;
}

}  // namespace ps_jni

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
  if (url == nullptr) {
    return JNI_FALSE;
  }
  const std::string utf8 = JStringToUtf8(env, url);
  return ps_sync_http_is_sync_stream_url(utf8.c_str()) != 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_powersync_lynx_SyncHttpSession_nativeLooksLikeLongLived(JNIEnv* env, jclass,
                                                                 jstring transferEncoding,
                                                                 jstring contentLength,
                                                                 jstring contentType) {
  const std::string enc = JStringToUtf8(env, transferEncoding);
  const std::string len = JStringToUtf8(env, contentLength);
  const std::string ct = JStringToUtf8(env, contentType);
  return ps_sync_http_looks_like_long_lived(
             transferEncoding != nullptr ? enc.c_str() : nullptr,
             contentLength != nullptr ? len.c_str() : nullptr,
             contentType != nullptr ? ct.c_str() : nullptr) != 0
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
  const std::string status_utf = JStringToUtf8(env, statusText);
  const std::string ct_utf = JStringToUtf8(env, contentType);
  JniStreamSink sink(env, sinkObj);
  session->OnHeaders(static_cast<int>(status), status_utf, ct_utf, sink);
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
  const std::string msg_utf = JStringToUtf8(env, message);
  JniStreamSink sink(env, sinkObj);
  session->OnError(msg_utf, sink);
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
