#ifndef POWERSYNC_LYNX_ANDROID_JNI_RUNTIME_H_
#define POWERSYNC_LYNX_ANDROID_JNI_RUNTIME_H_

#include <jni.h>

#include <string>

namespace ps_jni {

// Cached JavaVM from JNI_OnLoad (owned by jni_runtime.cc).
JavaVM* GetJavaVm();

// Looks up a class and promotes it to a global ref, returning nullptr on error.
jclass GlobalClass(JNIEnv* env, const char* name);

// Canonical strict UTF-16 <-> UTF-8 conversion for all Android JNI binders.
// Uses GetStringChars / NewString (UTF-16) instead of Modified UTF-8 so 4-byte
// supplementary code points round-trip losslessly, and replaces invalid /
// overlong / truncated UTF-8 sequences with U+FFFD.
std::string JStringToUtf8(JNIEnv* env, jstring value);
jstring Utf8ToJString(JNIEnv* env, const std::string& utf8);

// Per-binder initialization hooks invoked once from JNI_OnLoad.
bool InitPsSqlJni(JNIEnv* env);
bool InitSyncHttpSessionJni(JNIEnv* env);

}  // namespace ps_jni

#endif  // POWERSYNC_LYNX_ANDROID_JNI_RUNTIME_H_
