#include "ps_sql.h"

#include <jni.h>

#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace {

JavaVM* g_vm = nullptr;
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

jclass GlobalClass(JNIEnv* env, const char* name) {
  jclass local = env->FindClass(name);
  if (local == nullptr) {
    return nullptr;
  }
  jclass global = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  return global;
}

JNIEnv* AttachEnv(bool* attached) {
  *attached = false;
  if (g_vm == nullptr) {
    return nullptr;
  }
  JNIEnv* env = nullptr;
  const jint rc = g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (rc == JNI_OK) {
    return env;
  }
  // Android NDK jni.h: AttachCurrentThread(JNIEnv**, void*).
  // Desktop/OpenJDK jni.h: AttachCurrentThread(void**, void*).
#if defined(__ANDROID__)
  if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
    return nullptr;
  }
#else
  void* raw = env;
  if (g_vm->AttachCurrentThread(&raw, nullptr) != JNI_OK) {
    return nullptr;
  }
  env = static_cast<JNIEnv*>(raw);
#endif
  *attached = true;
  return env;
}

void DetachIfNeeded(bool attached) {
  if (attached && g_vm != nullptr) {
    g_vm->DetachCurrentThread();
  }
}

std::string JStringToUtf8(JNIEnv* env, jstring value) {
  if (value == nullptr) {
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
    if (cp >= 0xD800 && cp <= 0xDBFF && i < n) {
      const std::uint32_t low = chars[i];
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
        ++i;
      }
    }
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  env->ReleaseStringChars(value, chars);
  return out;
}

jstring Utf8ToJString(JNIEnv* env, const std::string& utf8) {
  std::vector<jchar> utf16;
  utf16.reserve(utf8.size());
  for (std::size_t i = 0; i < utf8.size();) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    std::uint32_t cp = 0;
    std::size_t need = 0;
    if (c < 0x80) {
      cp = c;
      need = 1;
    } else if ((c >> 5) == 0x6) {
      cp = c & 0x1F;
      need = 2;
    } else if ((c >> 4) == 0xE) {
      cp = c & 0x0F;
      need = 3;
    } else if ((c >> 3) == 0x1E) {
      cp = c & 0x07;
      need = 4;
    } else {
      cp = 0xFFFD;
      need = 1;
    }
    if (i + need > utf8.size()) {
      break;
    }
    for (std::size_t k = 1; k < need; ++k) {
      const unsigned char cont = static_cast<unsigned char>(utf8[i + k]);
      if ((cont >> 6) != 0x2) {
        cp = 0xFFFD;
        break;
      }
      cp = (cp << 6) | (cont & 0x3F);
    }
    i += need;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      utf16.push_back(static_cast<jchar>(0xD800 + (cp >> 10)));
      utf16.push_back(static_cast<jchar>(0xDC00 + (cp & 0x3FF)));
    } else {
      utf16.push_back(static_cast<jchar>(cp));
    }
  }
  if (utf16.empty()) {
    return env->NewString(nullptr, 0);
  }
  return env->NewString(utf16.data(), static_cast<jsize>(utf16.size()));
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

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  g_vm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return JNI_ERR;
  }
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
    return JNI_ERR;
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
    return JNI_ERR;
  }
  g_callback_invoke =
      env->GetMethodID(callback_cls, "invoke", "([Ljava/lang/Object;)V");
  env->DeleteGlobalRef(callback_cls);
  if (g_long_value_of == nullptr || g_long_value == nullptr ||
      g_int_value == nullptr || g_double_value_of == nullptr ||
      g_double_value == nullptr || g_to_writable == nullptr ||
      g_callback_invoke == nullptr) {
    return JNI_ERR;
  }
  return JNI_VERSION_1_6;
}

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
