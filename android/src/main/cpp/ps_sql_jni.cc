#include "jni_runtime.h"
#include "ps_sql.h"

#include <jni.h>

#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace {

using ps_jni::GlobalClass;
using ps_jni::JStringToUtf8;
using ps_jni::Utf8ToJString;

std::mutex g_engine_mu;
ps_sql::Engine* g_engine = nullptr;

jclass g_long_cls = nullptr;
jclass g_int_cls = nullptr;
jclass g_double_cls = nullptr;
jclass g_string_cls = nullptr;
jclass g_object_cls = nullptr;
jclass g_object_arr_cls = nullptr;
jclass g_byte_arr_cls = nullptr;
jclass g_engine_cls = nullptr;
jmethodID g_long_value_of = nullptr;
jmethodID g_long_value = nullptr;
jmethodID g_int_value = nullptr;
jmethodID g_double_value_of = nullptr;
jmethodID g_double_value = nullptr;
jmethodID g_to_writable = nullptr;
jmethodID g_callback_invoke = nullptr;

JNIEnv* AttachEnv(bool* attached) {
  *attached = false;
  JavaVM* vm = ps_jni::GetJavaVm();
  if (vm == nullptr) {
    return nullptr;
  }
  JNIEnv* env = nullptr;
  const jint rc = vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (rc == JNI_OK) {
    return env;
  }
  // Android NDK jni.h: AttachCurrentThread(JNIEnv**, void*).
  // Desktop/OpenJDK jni.h: AttachCurrentThread(void**, void*).
#if defined(__ANDROID__)
  if (vm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
    return nullptr;
  }
#else
  void* raw = env;
  if (vm->AttachCurrentThread(&raw, nullptr) != JNI_OK) {
    return nullptr;
  }
  env = static_cast<JNIEnv*>(raw);
#endif
  *attached = true;
  return env;
}

void DetachIfNeeded(bool attached) {
  JavaVM* vm = ps_jni::GetJavaVm();
  if (attached && vm != nullptr) {
    vm->DetachCurrentThread();
  }
}

bool ParseBind(JNIEnv* env, jobject value, ps_sql::BindValue* out, std::string* error) {
  if (value == nullptr) {
    out->kind = ps_sql::CellKind::kNull;
    return true;
  }
  if (env->IsInstanceOf(value, g_long_cls)) {
    out->kind = ps_sql::CellKind::kInteger;
    out->i = env->CallLongMethod(value, g_long_value);
    return true;
  }
  if (env->IsInstanceOf(value, g_int_cls)) {
    out->kind = ps_sql::CellKind::kInteger;
    out->i = env->CallIntMethod(value, g_int_value);
    return true;
  }
  if (env->IsInstanceOf(value, g_double_cls)) {
    out->kind = ps_sql::CellKind::kFloat;
    out->f = env->CallDoubleMethod(value, g_double_value);
    return true;
  }
  if (env->IsInstanceOf(value, g_string_cls)) {
    out->kind = ps_sql::CellKind::kText;
    out->text = JStringToUtf8(env, static_cast<jstring>(value));
    return true;
  }
  if (env->IsInstanceOf(value, g_byte_arr_cls)) {
    auto* bytes = static_cast<jbyteArray>(value);
    const jsize n = env->GetArrayLength(bytes);
    out->kind = ps_sql::CellKind::kBlob;
    if (n > 0) {
      jbyte* raw = env->GetByteArrayElements(bytes, nullptr);
      out->blob.assign(reinterpret_cast<const std::uint8_t*>(raw),
                       reinterpret_cast<const std::uint8_t*>(raw) + n);
      env->ReleaseByteArrayElements(bytes, raw, JNI_ABORT);
    }
    return true;
  }
  *error = "unsupported bind value";
  return false;
}

bool ParseParams(JNIEnv* env, jobjectArray params, std::vector<ps_sql::BindValue>* out,
                 std::string* error) {
  out->clear();
  if (params == nullptr) {
    return true;
  }
  const jsize n = env->GetArrayLength(params);
  out->reserve(static_cast<std::size_t>(n));
  for (jsize i = 0; i < n; ++i) {
    jobject value = env->GetObjectArrayElement(params, i);
    ps_sql::BindValue bind;
    if (!ParseBind(env, value, &bind, error)) {
      if (value != nullptr) {
        env->DeleteLocalRef(value);
      }
      return false;
    }
    out->push_back(std::move(bind));
    if (value != nullptr) {
      env->DeleteLocalRef(value);
    }
  }
  return true;
}

jobject CellToJava(JNIEnv* env, const ps_sql::Cell& cell) {
  switch (cell.kind) {
    case ps_sql::CellKind::kNull:
      return nullptr;
    case ps_sql::CellKind::kInteger: {
      if (cell.integer_as_bigint) {
        return env->CallStaticObjectMethod(g_long_cls, g_long_value_of, cell.i);
      }
      return env->CallStaticObjectMethod(g_double_cls, g_double_value_of,
                                         static_cast<jdouble>(cell.i));
    }
    case ps_sql::CellKind::kFloat:
      return env->CallStaticObjectMethod(g_double_cls, g_double_value_of, cell.f);
    case ps_sql::CellKind::kText:
      return Utf8ToJString(env, cell.text);
    case ps_sql::CellKind::kBlob: {
      jbyteArray bytes = env->NewByteArray(static_cast<jsize>(cell.blob.size()));
      if (!cell.blob.empty()) {
        env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(cell.blob.size()),
                                reinterpret_cast<const jbyte*>(cell.blob.data()));
      }
      return bytes;
    }
  }
  return nullptr;
}

jobject EnvelopeToJava(JNIEnv* env, const ps_sql::Envelope& envelope) {
  jstring message = envelope.ok ? nullptr : Utf8ToJString(env, envelope.message);
  jstring db_id =
      envelope.db_id.empty() ? nullptr : Utf8ToJString(env, envelope.db_id);
  const jboolean has_code = envelope.code.has_value() ? JNI_TRUE : JNI_FALSE;
  const jint code = envelope.code.has_value() ? *envelope.code : 0;
  jobjectArray names = nullptr;
  jobjectArray rows = nullptr;
  if (envelope.ok) {
    names = env->NewObjectArray(static_cast<jsize>(envelope.column_names.size()),
                                g_string_cls, nullptr);
    for (std::size_t i = 0; i < envelope.column_names.size(); ++i) {
      jstring name = Utf8ToJString(env, envelope.column_names[i]);
      env->SetObjectArrayElement(names, static_cast<jsize>(i), name);
      env->DeleteLocalRef(name);
    }
    rows = env->NewObjectArray(static_cast<jsize>(envelope.raw_rows.size()),
                               g_object_arr_cls, nullptr);
    for (std::size_t r = 0; r < envelope.raw_rows.size(); ++r) {
      const auto& row = envelope.raw_rows[r];
      jobjectArray cells =
          env->NewObjectArray(static_cast<jsize>(row.size()), g_object_cls, nullptr);
      for (std::size_t c = 0; c < row.size(); ++c) {
        jobject cell = CellToJava(env, row[c]);
        env->SetObjectArrayElement(cells, static_cast<jsize>(c), cell);
        if (cell != nullptr) {
          env->DeleteLocalRef(cell);
        }
      }
      env->SetObjectArrayElement(rows, static_cast<jsize>(r), cells);
      env->DeleteLocalRef(cells);
    }
  }
  jobject map = env->CallStaticObjectMethod(
      g_engine_cls, g_to_writable, envelope.ok ? JNI_TRUE : JNI_FALSE, message,
      has_code, code, db_id, static_cast<jlong>(envelope.insert_id),
      static_cast<jlong>(envelope.rows_affected), names, rows);
  if (message != nullptr) {
    env->DeleteLocalRef(message);
  }
  if (db_id != nullptr) {
    env->DeleteLocalRef(db_id);
  }
  if (names != nullptr) {
    env->DeleteLocalRef(names);
  }
  if (rows != nullptr) {
    env->DeleteLocalRef(rows);
  }
  return map;
}

void Deliver(jobject callback_global, ps_sql::Envelope envelope) {
  bool attached = false;
  JNIEnv* env = AttachEnv(&attached);
  if (env == nullptr || callback_global == nullptr) {
    if (callback_global != nullptr && env != nullptr) {
      env->DeleteGlobalRef(callback_global);
    }
    DetachIfNeeded(attached);
    return;
  }
  jobject map = EnvelopeToJava(env, envelope);
  jobjectArray args = env->NewObjectArray(1, g_object_cls, map);
  env->CallVoidMethod(callback_global, g_callback_invoke, args);
  env->DeleteLocalRef(args);
  if (map != nullptr) {
    env->DeleteLocalRef(map);
  }
  env->DeleteGlobalRef(callback_global);
  DetachIfNeeded(attached);
}

jobject RetainCallback(JNIEnv* env, jobject callback) {
  if (callback == nullptr) {
    return nullptr;
  }
  return env->NewGlobalRef(callback);
}

ps_sql::Engine* SharedEngine(std::string* error) {
  std::lock_guard<std::mutex> lock(g_engine_mu);
  if (g_engine == nullptr) {
    *error = "ps_sql JNI engine is not initialized";
    return nullptr;
  }
  return g_engine;
}

}  // namespace

namespace ps_jni {

bool InitPsSqlJni(JNIEnv* env) {
  g_long_cls = GlobalClass(env, "java/lang/Long");
  g_int_cls = GlobalClass(env, "java/lang/Integer");
  g_double_cls = GlobalClass(env, "java/lang/Double");
  g_string_cls = GlobalClass(env, "java/lang/String");
  g_object_cls = GlobalClass(env, "java/lang/Object");
  g_object_arr_cls = GlobalClass(env, "[Ljava/lang/Object;");
  g_byte_arr_cls = GlobalClass(env, "[B");
  g_engine_cls = GlobalClass(env, "com/powersync/lynx/PsSqlEngine");
  if (g_long_cls == nullptr || g_int_cls == nullptr || g_double_cls == nullptr ||
      g_string_cls == nullptr || g_object_cls == nullptr ||
      g_object_arr_cls == nullptr || g_byte_arr_cls == nullptr ||
      g_engine_cls == nullptr) {
    return false;
  }
  g_long_value_of =
      env->GetStaticMethodID(g_long_cls, "valueOf", "(J)Ljava/lang/Long;");
  g_long_value = env->GetMethodID(g_long_cls, "longValue", "()J");
  g_int_value = env->GetMethodID(g_int_cls, "intValue", "()I");
  g_double_value_of =
      env->GetStaticMethodID(g_double_cls, "valueOf", "(D)Ljava/lang/Double;");
  g_double_value = env->GetMethodID(g_double_cls, "doubleValue", "()D");
  g_to_writable = env->GetStaticMethodID(
      g_engine_cls, "toWritable",
      "(ZLjava/lang/String;ZILjava/lang/String;JJ[Ljava/lang/String;[[Ljava/lang/Object;)Lcom/lynx/react/bridge/WritableMap;");
  jclass callback_cls = GlobalClass(env, "com/lynx/react/bridge/Callback");
  if (callback_cls == nullptr) {
    return false;
  }
  g_callback_invoke =
      env->GetMethodID(callback_cls, "invoke", "([Ljava/lang/Object;)V");
  env->DeleteGlobalRef(callback_cls);
  return g_long_value_of != nullptr && g_long_value != nullptr &&
         g_int_value != nullptr && g_double_value_of != nullptr &&
         g_double_value != nullptr && g_to_writable != nullptr &&
         g_callback_invoke != nullptr;
}

}  // namespace ps_jni

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_PsSqlEngine_nativeInit(JNIEnv* env, jclass,
                                               jstring core_path) {
  std::lock_guard<std::mutex> lock(g_engine_mu);
  if (g_engine != nullptr) {
    return;
  }
  ps_sql::EngineConfig config;
  config.core_load = ps_sql::CoreLoad::kLoadExtension;
  config.core_path = JStringToUtf8(env, core_path);
  g_engine = new ps_sql::Engine(std::move(config));
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_PsSqlEngine_nativeOpen(JNIEnv* env, jclass,
                                               jstring db_filename,
                                               jstring db_location,
                                               jboolean read_only,
                                               jobject callback) {
  jobject cb = RetainCallback(env, callback);
  std::string error;
  ps_sql::Engine* engine = SharedEngine(&error);
  if (engine == nullptr) {
    Deliver(cb, ps_sql::fail(std::move(error)));
    return;
  }
  ps_sql::OpenOptions options;
  options.db_filename = JStringToUtf8(env, db_filename);
  if (db_location != nullptr) {
    options.db_location = JStringToUtf8(env, db_location);
  }
  options.read_only = read_only == JNI_TRUE;
  engine->open(std::move(options),
               [cb](ps_sql::Envelope env) { Deliver(cb, std::move(env)); });
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_PsSqlEngine_nativeClose(JNIEnv* env, jclass,
                                                jstring db_id,
                                                jobject callback) {
  jobject cb = RetainCallback(env, callback);
  std::string error;
  ps_sql::Engine* engine = SharedEngine(&error);
  if (engine == nullptr) {
    Deliver(cb, ps_sql::fail(std::move(error)));
    return;
  }
  engine->close(JStringToUtf8(env, db_id),
                [cb](ps_sql::Envelope env) { Deliver(cb, std::move(env)); });
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_PsSqlEngine_nativeExecute(JNIEnv* env, jclass,
                                                  jstring db_id, jstring sql,
                                                  jobjectArray params,
                                                  jobject callback) {
  jobject cb = RetainCallback(env, callback);
  std::string error;
  ps_sql::Engine* engine = SharedEngine(&error);
  if (engine == nullptr) {
    Deliver(cb, ps_sql::fail(std::move(error)));
    return;
  }
  std::vector<ps_sql::BindValue> binds;
  if (!ParseParams(env, params, &binds, &error)) {
    Deliver(cb, ps_sql::fail(std::move(error)));
    return;
  }
  engine->execute(JStringToUtf8(env, db_id), JStringToUtf8(env, sql),
                  std::move(binds),
                  [cb](ps_sql::Envelope env) { Deliver(cb, std::move(env)); });
}

extern "C" JNIEXPORT void JNICALL
Java_com_powersync_lynx_PsSqlEngine_nativeExecuteBatch(JNIEnv* env, jclass,
                                                       jstring db_id,
                                                       jstring sql,
                                                       jobjectArray rows,
                                                       jobject callback) {
  jobject cb = RetainCallback(env, callback);
  std::string error;
  ps_sql::Engine* engine = SharedEngine(&error);
  if (engine == nullptr) {
    Deliver(cb, ps_sql::fail(std::move(error)));
    return;
  }
  std::vector<std::vector<ps_sql::BindValue>> bind_rows;
  if (rows != nullptr) {
    const jsize n = env->GetArrayLength(rows);
    bind_rows.reserve(static_cast<std::size_t>(n));
    for (jsize i = 0; i < n; ++i) {
      jobject row_obj = env->GetObjectArrayElement(rows, i);
      if (row_obj != nullptr && !env->IsInstanceOf(row_obj, g_object_arr_cls)) {
        env->DeleteLocalRef(row_obj);
        Deliver(cb, ps_sql::fail("params must be an array of parameter rows"));
        return;
      }
      std::vector<ps_sql::BindValue> binds;
      if (!ParseParams(env, static_cast<jobjectArray>(row_obj), &binds,
                       &error)) {
        if (row_obj != nullptr) {
          env->DeleteLocalRef(row_obj);
        }
        Deliver(cb, ps_sql::fail(std::move(error)));
        return;
      }
      bind_rows.push_back(std::move(binds));
      if (row_obj != nullptr) {
        env->DeleteLocalRef(row_obj);
      }
    }
  }
  engine->execute_batch(
      JStringToUtf8(env, db_id), JStringToUtf8(env, sql), std::move(bind_rows),
      [cb](ps_sql::Envelope env) { Deliver(cb, std::move(env)); });
}
