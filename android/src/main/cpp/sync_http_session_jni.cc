#include "sync_http_session.h"

#include <jni.h>

namespace {

ps_sync_http_session* session_from(jlong handle) {
  if (handle == 0) {
    return nullptr;
  }
  return reinterpret_cast<ps_sync_http_session*>(handle);
}

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
