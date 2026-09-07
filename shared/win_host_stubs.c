#include <windows.h>

static FARPROC resolve_sym(const char* name) {
  static const char* kMods[] = {"lynxtron.dll", "node.exe", "node.dll", "lynxtron.exe", 0};
  HMODULE m = GetModuleHandleA(0);
  FARPROC p = m ? GetProcAddress(m, name) : 0;
  if (p) return p;
  for (int i = 0; kMods[i]; ++i) {
    m = GetModuleHandleA(kMods[i]);
    if (!m) continue;
    p = GetProcAddress(m, name);
    if (p) return p;
  }
  return 0;
}

static void unresolved(const char* name) {
  char buf[256];
  wsprintfA(buf, "powersync-lynx: unresolved %s", name);
  OutputDebugStringA(buf);
}

static void* bind_sym(void** slot, const char* name) {
  void* p = *slot;
  if (p) {
    return p;
  }
  p = (void*)resolve_sym(name);
  *slot = p;
  if (!p) {
    unresolved(name);
  }
  return p;
}

void* p_napi_add_finalizer_weak;
void* p_napi_call_function_weak;
void* p_napi_call_threadsafe_function_weak;
void* p_napi_close_escapable_handle_scope_weak;
void* p_napi_close_handle_scope_weak;
void* p_napi_create_array_with_length_weak;
void* p_napi_create_arraybuffer_weak;
void* p_napi_create_bigint_int64_weak;
void* p_napi_create_double_weak;
void* p_napi_create_error_weak;
void* p_napi_create_function_weak;
void* p_napi_create_object_weak;
void* p_napi_create_reference_weak;
void* p_napi_create_string_utf8_weak;
void* p_napi_create_threadsafe_function_weak;
void* p_napi_create_type_error_weak;
void* p_napi_define_properties_weak;
void* p_napi_delete_reference_weak;
void* p_napi_escape_handle_weak;
void* p_napi_fatal_error_weak;
void* p_napi_get_and_clear_last_exception_weak;
void* p_napi_get_array_length_weak;
void* p_napi_get_arraybuffer_info_weak;
void* p_napi_get_boolean_weak;
void* p_napi_get_cb_info_weak;
void* p_napi_get_element_weak;
void* p_napi_get_last_error_info_weak;
void* p_napi_get_named_property_weak;
void* p_napi_get_null_weak;
void* p_napi_get_property_weak;
void* p_napi_get_reference_value_weak;
void* p_napi_get_undefined_weak;
void* p_napi_get_value_bigint_int64_weak;
void* p_napi_get_value_bool_weak;
void* p_napi_get_value_double_weak;
void* p_napi_get_value_string_utf8_weak;
void* p_napi_has_named_property_weak;
void* p_napi_has_property_weak;
void* p_napi_is_array_weak;
void* p_napi_is_arraybuffer_weak;
void* p_napi_is_exception_pending_weak;
void* p_napi_open_escapable_handle_scope_weak;
void* p_napi_open_handle_scope_weak;
void* p_napi_release_threadsafe_function_weak;
void* p_napi_set_element_weak;
void* p_napi_set_named_property_weak;
void* p_napi_throw_weak;
void* p_napi_typeof_weak;
void* p_napi_module_register;
void* p_lynx_env_register_native_module;

__attribute__((naked)) void napi_add_finalizer_weak(void) {
  __asm__ volatile ("jmpq *p_napi_add_finalizer_weak(%rip)");
}

__attribute__((naked)) void napi_call_function_weak(void) {
  __asm__ volatile ("jmpq *p_napi_call_function_weak(%rip)");
}

__attribute__((naked)) void napi_call_threadsafe_function_weak(void) {
  __asm__ volatile ("jmpq *p_napi_call_threadsafe_function_weak(%rip)");
}

__attribute__((naked)) void napi_close_escapable_handle_scope_weak(void) {
  __asm__ volatile ("jmpq *p_napi_close_escapable_handle_scope_weak(%rip)");
}

__attribute__((naked)) void napi_close_handle_scope_weak(void) {
  __asm__ volatile ("jmpq *p_napi_close_handle_scope_weak(%rip)");
}

__attribute__((naked)) void napi_create_array_with_length_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_array_with_length_weak(%rip)");
}

__attribute__((naked)) void napi_create_arraybuffer_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_arraybuffer_weak(%rip)");
}

__attribute__((naked)) void napi_create_bigint_int64_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_bigint_int64_weak(%rip)");
}

__attribute__((naked)) void napi_create_double_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_double_weak(%rip)");
}

__attribute__((naked)) void napi_create_error_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_error_weak(%rip)");
}

__attribute__((naked)) void napi_create_function_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_function_weak(%rip)");
}

__attribute__((naked)) void napi_create_object_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_object_weak(%rip)");
}

__attribute__((naked)) void napi_create_reference_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_reference_weak(%rip)");
}

__attribute__((naked)) void napi_create_string_utf8_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_string_utf8_weak(%rip)");
}

__attribute__((naked)) void napi_create_threadsafe_function_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_threadsafe_function_weak(%rip)");
}

__attribute__((naked)) void napi_create_type_error_weak(void) {
  __asm__ volatile ("jmpq *p_napi_create_type_error_weak(%rip)");
}

__attribute__((naked)) void napi_define_properties_weak(void) {
  __asm__ volatile ("jmpq *p_napi_define_properties_weak(%rip)");
}

__attribute__((naked)) void napi_delete_reference_weak(void) {
  __asm__ volatile ("jmpq *p_napi_delete_reference_weak(%rip)");
}

__attribute__((naked)) void napi_escape_handle_weak(void) {
  __asm__ volatile ("jmpq *p_napi_escape_handle_weak(%rip)");
}

__attribute__((naked)) void napi_fatal_error_weak(void) {
  __asm__ volatile ("jmpq *p_napi_fatal_error_weak(%rip)");
}

__attribute__((naked)) void napi_get_and_clear_last_exception_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_and_clear_last_exception_weak(%rip)");
}

__attribute__((naked)) void napi_get_array_length_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_array_length_weak(%rip)");
}

__attribute__((naked)) void napi_get_arraybuffer_info_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_arraybuffer_info_weak(%rip)");
}

__attribute__((naked)) void napi_get_boolean_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_boolean_weak(%rip)");
}

__attribute__((naked)) void napi_get_cb_info_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_cb_info_weak(%rip)");
}

__attribute__((naked)) void napi_get_element_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_element_weak(%rip)");
}

__attribute__((naked)) void napi_get_last_error_info_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_last_error_info_weak(%rip)");
}

__attribute__((naked)) void napi_get_named_property_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_named_property_weak(%rip)");
}

__attribute__((naked)) void napi_get_null_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_null_weak(%rip)");
}

__attribute__((naked)) void napi_get_property_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_property_weak(%rip)");
}

__attribute__((naked)) void napi_get_reference_value_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_reference_value_weak(%rip)");
}

__attribute__((naked)) void napi_get_undefined_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_undefined_weak(%rip)");
}

__attribute__((naked)) void napi_get_value_bigint_int64_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_value_bigint_int64_weak(%rip)");
}

__attribute__((naked)) void napi_get_value_bool_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_value_bool_weak(%rip)");
}

__attribute__((naked)) void napi_get_value_double_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_value_double_weak(%rip)");
}

__attribute__((naked)) void napi_get_value_string_utf8_weak(void) {
  __asm__ volatile ("jmpq *p_napi_get_value_string_utf8_weak(%rip)");
}

__attribute__((naked)) void napi_has_named_property_weak(void) {
  __asm__ volatile ("jmpq *p_napi_has_named_property_weak(%rip)");
}

__attribute__((naked)) void napi_has_property_weak(void) {
  __asm__ volatile ("jmpq *p_napi_has_property_weak(%rip)");
}

__attribute__((naked)) void napi_is_array_weak(void) {
  __asm__ volatile ("jmpq *p_napi_is_array_weak(%rip)");
}

__attribute__((naked)) void napi_is_arraybuffer_weak(void) {
  __asm__ volatile ("jmpq *p_napi_is_arraybuffer_weak(%rip)");
}

__attribute__((naked)) void napi_is_exception_pending_weak(void) {
  __asm__ volatile ("jmpq *p_napi_is_exception_pending_weak(%rip)");
}

__attribute__((naked)) void napi_open_escapable_handle_scope_weak(void) {
  __asm__ volatile ("jmpq *p_napi_open_escapable_handle_scope_weak(%rip)");
}

__attribute__((naked)) void napi_open_handle_scope_weak(void) {
  __asm__ volatile ("jmpq *p_napi_open_handle_scope_weak(%rip)");
}

__attribute__((naked)) void napi_release_threadsafe_function_weak(void) {
  __asm__ volatile ("jmpq *p_napi_release_threadsafe_function_weak(%rip)");
}

__attribute__((naked)) void napi_set_element_weak(void) {
  __asm__ volatile ("jmpq *p_napi_set_element_weak(%rip)");
}

__attribute__((naked)) void napi_set_named_property_weak(void) {
  __asm__ volatile ("jmpq *p_napi_set_named_property_weak(%rip)");
}

__attribute__((naked)) void napi_throw_weak(void) {
  __asm__ volatile ("jmpq *p_napi_throw_weak(%rip)");
}

__attribute__((naked)) void napi_typeof_weak(void) {
  __asm__ volatile ("jmpq *p_napi_typeof_weak(%rip)");
}

void napi_module_register(void* mod) {
  void (*fn)(void*) =
      (void (*)(void*))bind_sym(&p_napi_module_register, "napi_module_register");
  if (!fn) {
    return;
  }
  fn(mod);
}

void lynx_env_register_native_module(const char* name, void* creator,
                                     void* opaque) {
  void (*fn)(const char*, void*, void*) =
      (void (*)(const char*, void*, void*))bind_sym(
          &p_lynx_env_register_native_module, "lynx_env_register_native_module");
  if (!fn) {
    return;
  }
  fn(name, creator, opaque);
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h; (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) {
    p_napi_add_finalizer_weak = (void*)resolve_sym("napi_add_finalizer_weak");
    if (!p_napi_add_finalizer_weak) unresolved("napi_add_finalizer_weak");
    p_napi_call_function_weak = (void*)resolve_sym("napi_call_function_weak");
    if (!p_napi_call_function_weak) unresolved("napi_call_function_weak");
    p_napi_call_threadsafe_function_weak = (void*)resolve_sym("napi_call_threadsafe_function_weak");
    if (!p_napi_call_threadsafe_function_weak) unresolved("napi_call_threadsafe_function_weak");
    p_napi_close_escapable_handle_scope_weak = (void*)resolve_sym("napi_close_escapable_handle_scope_weak");
    if (!p_napi_close_escapable_handle_scope_weak) unresolved("napi_close_escapable_handle_scope_weak");
    p_napi_close_handle_scope_weak = (void*)resolve_sym("napi_close_handle_scope_weak");
    if (!p_napi_close_handle_scope_weak) unresolved("napi_close_handle_scope_weak");
    p_napi_create_array_with_length_weak = (void*)resolve_sym("napi_create_array_with_length_weak");
    if (!p_napi_create_array_with_length_weak) unresolved("napi_create_array_with_length_weak");
    p_napi_create_arraybuffer_weak = (void*)resolve_sym("napi_create_arraybuffer_weak");
    if (!p_napi_create_arraybuffer_weak) unresolved("napi_create_arraybuffer_weak");
    p_napi_create_bigint_int64_weak = (void*)resolve_sym("napi_create_bigint_int64_weak");
    if (!p_napi_create_bigint_int64_weak) unresolved("napi_create_bigint_int64_weak");
    p_napi_create_double_weak = (void*)resolve_sym("napi_create_double_weak");
    if (!p_napi_create_double_weak) unresolved("napi_create_double_weak");
    p_napi_create_error_weak = (void*)resolve_sym("napi_create_error_weak");
    if (!p_napi_create_error_weak) unresolved("napi_create_error_weak");
    p_napi_create_function_weak = (void*)resolve_sym("napi_create_function_weak");
    if (!p_napi_create_function_weak) unresolved("napi_create_function_weak");
    p_napi_create_object_weak = (void*)resolve_sym("napi_create_object_weak");
    if (!p_napi_create_object_weak) unresolved("napi_create_object_weak");
    p_napi_create_reference_weak = (void*)resolve_sym("napi_create_reference_weak");
    if (!p_napi_create_reference_weak) unresolved("napi_create_reference_weak");
    p_napi_create_string_utf8_weak = (void*)resolve_sym("napi_create_string_utf8_weak");
    if (!p_napi_create_string_utf8_weak) unresolved("napi_create_string_utf8_weak");
    p_napi_create_threadsafe_function_weak = (void*)resolve_sym("napi_create_threadsafe_function_weak");
    if (!p_napi_create_threadsafe_function_weak) unresolved("napi_create_threadsafe_function_weak");
    p_napi_create_type_error_weak = (void*)resolve_sym("napi_create_type_error_weak");
    if (!p_napi_create_type_error_weak) unresolved("napi_create_type_error_weak");
    p_napi_define_properties_weak = (void*)resolve_sym("napi_define_properties_weak");
    if (!p_napi_define_properties_weak) unresolved("napi_define_properties_weak");
    p_napi_delete_reference_weak = (void*)resolve_sym("napi_delete_reference_weak");
    if (!p_napi_delete_reference_weak) unresolved("napi_delete_reference_weak");
    p_napi_escape_handle_weak = (void*)resolve_sym("napi_escape_handle_weak");
    if (!p_napi_escape_handle_weak) unresolved("napi_escape_handle_weak");
    p_napi_fatal_error_weak = (void*)resolve_sym("napi_fatal_error_weak");
    if (!p_napi_fatal_error_weak) unresolved("napi_fatal_error_weak");
    p_napi_get_and_clear_last_exception_weak = (void*)resolve_sym("napi_get_and_clear_last_exception_weak");
    if (!p_napi_get_and_clear_last_exception_weak) unresolved("napi_get_and_clear_last_exception_weak");
    p_napi_get_array_length_weak = (void*)resolve_sym("napi_get_array_length_weak");
    if (!p_napi_get_array_length_weak) unresolved("napi_get_array_length_weak");
    p_napi_get_arraybuffer_info_weak = (void*)resolve_sym("napi_get_arraybuffer_info_weak");
    if (!p_napi_get_arraybuffer_info_weak) unresolved("napi_get_arraybuffer_info_weak");
    p_napi_get_boolean_weak = (void*)resolve_sym("napi_get_boolean_weak");
    if (!p_napi_get_boolean_weak) unresolved("napi_get_boolean_weak");
    p_napi_get_cb_info_weak = (void*)resolve_sym("napi_get_cb_info_weak");
    if (!p_napi_get_cb_info_weak) unresolved("napi_get_cb_info_weak");
    p_napi_get_element_weak = (void*)resolve_sym("napi_get_element_weak");
    if (!p_napi_get_element_weak) unresolved("napi_get_element_weak");
    p_napi_get_last_error_info_weak = (void*)resolve_sym("napi_get_last_error_info_weak");
    if (!p_napi_get_last_error_info_weak) unresolved("napi_get_last_error_info_weak");
    p_napi_get_named_property_weak = (void*)resolve_sym("napi_get_named_property_weak");
    if (!p_napi_get_named_property_weak) unresolved("napi_get_named_property_weak");
    p_napi_get_null_weak = (void*)resolve_sym("napi_get_null_weak");
    if (!p_napi_get_null_weak) unresolved("napi_get_null_weak");
    p_napi_get_property_weak = (void*)resolve_sym("napi_get_property_weak");
    if (!p_napi_get_property_weak) unresolved("napi_get_property_weak");
    p_napi_get_reference_value_weak = (void*)resolve_sym("napi_get_reference_value_weak");
    if (!p_napi_get_reference_value_weak) unresolved("napi_get_reference_value_weak");
    p_napi_get_undefined_weak = (void*)resolve_sym("napi_get_undefined_weak");
    if (!p_napi_get_undefined_weak) unresolved("napi_get_undefined_weak");
    p_napi_get_value_bigint_int64_weak = (void*)resolve_sym("napi_get_value_bigint_int64_weak");
    if (!p_napi_get_value_bigint_int64_weak) unresolved("napi_get_value_bigint_int64_weak");
    p_napi_get_value_bool_weak = (void*)resolve_sym("napi_get_value_bool_weak");
    if (!p_napi_get_value_bool_weak) unresolved("napi_get_value_bool_weak");
    p_napi_get_value_double_weak = (void*)resolve_sym("napi_get_value_double_weak");
    if (!p_napi_get_value_double_weak) unresolved("napi_get_value_double_weak");
    p_napi_get_value_string_utf8_weak = (void*)resolve_sym("napi_get_value_string_utf8_weak");
    if (!p_napi_get_value_string_utf8_weak) unresolved("napi_get_value_string_utf8_weak");
    p_napi_has_named_property_weak = (void*)resolve_sym("napi_has_named_property_weak");
    if (!p_napi_has_named_property_weak) unresolved("napi_has_named_property_weak");
    p_napi_has_property_weak = (void*)resolve_sym("napi_has_property_weak");
    if (!p_napi_has_property_weak) unresolved("napi_has_property_weak");
    p_napi_is_array_weak = (void*)resolve_sym("napi_is_array_weak");
    if (!p_napi_is_array_weak) unresolved("napi_is_array_weak");
    p_napi_is_arraybuffer_weak = (void*)resolve_sym("napi_is_arraybuffer_weak");
    if (!p_napi_is_arraybuffer_weak) unresolved("napi_is_arraybuffer_weak");
    p_napi_is_exception_pending_weak = (void*)resolve_sym("napi_is_exception_pending_weak");
    if (!p_napi_is_exception_pending_weak) unresolved("napi_is_exception_pending_weak");
    p_napi_open_escapable_handle_scope_weak = (void*)resolve_sym("napi_open_escapable_handle_scope_weak");
    if (!p_napi_open_escapable_handle_scope_weak) unresolved("napi_open_escapable_handle_scope_weak");
    p_napi_open_handle_scope_weak = (void*)resolve_sym("napi_open_handle_scope_weak");
    if (!p_napi_open_handle_scope_weak) unresolved("napi_open_handle_scope_weak");
    p_napi_release_threadsafe_function_weak = (void*)resolve_sym("napi_release_threadsafe_function_weak");
    if (!p_napi_release_threadsafe_function_weak) unresolved("napi_release_threadsafe_function_weak");
    p_napi_set_element_weak = (void*)resolve_sym("napi_set_element_weak");
    if (!p_napi_set_element_weak) unresolved("napi_set_element_weak");
    p_napi_set_named_property_weak = (void*)resolve_sym("napi_set_named_property_weak");
    if (!p_napi_set_named_property_weak) unresolved("napi_set_named_property_weak");
    p_napi_throw_weak = (void*)resolve_sym("napi_throw_weak");
    if (!p_napi_throw_weak) unresolved("napi_throw_weak");
    p_napi_typeof_weak = (void*)resolve_sym("napi_typeof_weak");
    if (!p_napi_typeof_weak) unresolved("napi_typeof_weak");
    p_napi_module_register = (void*)resolve_sym("napi_module_register");
    if (!p_napi_module_register) unresolved("napi_module_register");
    p_lynx_env_register_native_module = (void*)resolve_sym("lynx_env_register_native_module");
    if (!p_lynx_env_register_native_module) unresolved("lynx_env_register_native_module");
  }
  return TRUE;
}

/* dllimport IAT slot used by lynx_extension.h */
void (*__imp_lynx_env_register_native_module)(const char*, void*, void*) =
    lynx_env_register_native_module;
