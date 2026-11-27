cmake_minimum_required(VERSION 3.22)
project(powersync_lynx_native LANGUAGES C CXX)
if(APPLE)
  enable_language(OBJCXX)
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

get_filename_component(_powersync_lynx_root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(POWERSYNC_LYNX_ROOT "${_powersync_lynx_root}" CACHE INTERNAL "Root directory of powersync-lynx")
set(SQLITE_DIR "${POWERSYNC_LYNX_ROOT}/third_party/sqlite")

add_library(ps_sql STATIC
  ps_sql.cc
  "${SQLITE_DIR}/sqlite3.c"
)
target_include_directories(ps_sql PUBLIC
  "${CMAKE_CURRENT_LIST_DIR}"
  "${SQLITE_DIR}"
)
target_compile_definitions(ps_sql PRIVATE
  SQLITE_THREADSAFE=1
  SQLITE_ENABLE_LOAD_EXTENSION=1
  SQLITE_DQS=0
  SQLITE_ENABLE_FTS5=1
  SQLITE_ENABLE_JSON1=1
  SQLITE_ENABLE_MATH_FUNCTIONS=1
  SQLITE_USE_URI=1
  SQLITE_DEFAULT_MEMSTATUS=0
  SQLITE_OMIT_DEPRECATED
)
if(UNIX)
  target_link_libraries(ps_sql PUBLIC pthread dl)
endif()
if(MSVC)
  target_compile_options(ps_sql PRIVATE /utf-8)
endif()

set(_powersync_default_build_napi OFF)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  set(_powersync_default_build_napi ON)
endif()
option(
  POWERSYNC_BUILD_LYNXTRON_NAPI
  "Build the Lynxtron N-API .node module (requires @lynx-js/lynx-library-headers)"
  ${_powersync_default_build_napi}
)

# Resolve optional Lynx Desktop SDK / header include paths for native CMake LynxView consumers.
set(_ps_lynx_sdk_dir "${LYNX_SDK_DIR}")
if(NOT _ps_lynx_sdk_dir AND DEFINED ENV{LYNX_SDK_DIR})
  set(_ps_lynx_sdk_dir "$ENV{LYNX_SDK_DIR}")
endif()

set(_ps_native_includes "")
if(_ps_lynx_sdk_dir)
  if(EXISTS "${_ps_lynx_sdk_dir}/include")
    list(APPEND _ps_native_includes "${_ps_lynx_sdk_dir}/include")
  endif()
  if(EXISTS "${_ps_lynx_sdk_dir}/include/third_party/weak-node-api/headers")
    list(APPEND _ps_native_includes "${_ps_lynx_sdk_dir}/include/third_party/weak-node-api/headers")
  endif()
endif()
if(DEFINED POWERSYNC_LYNX_INCLUDE_DIRS AND POWERSYNC_LYNX_INCLUDE_DIRS)
  list(APPEND _ps_native_includes ${POWERSYNC_LYNX_INCLUDE_DIRS})
endif()

set(_ps_http_sources
  sync_http/sync_http_session.cc
  sync_http/sync_http_engine.cc
)
if(APPLE)
  list(APPEND _ps_http_sources sync_http/apple_sync_http.mm)
  set_source_files_properties(sync_http/apple_sync_http.mm PROPERTIES
    COMPILE_OPTIONS "-fobjc-arc"
  )
elseif(WIN32)
  list(APPEND _ps_http_sources sync_http/win_sync_http.cc)
endif()

# Native CMake LynxView embedder library (no lynxtron/library_entry.cc, no native-vendor/).
# When building standalone Lynxtron N-API without LYNX_SDK_DIR, keep powersync_lynx_native
# out of ALL so `cmake --build` does not fail on missing desktop SDK headers.
if(POWERSYNC_BUILD_LYNXTRON_NAPI AND NOT _ps_native_includes)
  add_library(powersync_lynx_native STATIC EXCLUDE_FROM_ALL
    nativeModule/NativePowerSyncModule.cc
    nativeModule/NativeSyncHttpNapi.cc
    ${_ps_http_sources}
  )
else()
  add_library(powersync_lynx_native STATIC
    nativeModule/NativePowerSyncModule.cc
    nativeModule/NativeSyncHttpNapi.cc
    ${_ps_http_sources}
  )
endif()
target_link_libraries(powersync_lynx_native PRIVATE ps_sql)
target_include_directories(powersync_lynx_native
  PUBLIC
    "${CMAKE_CURRENT_LIST_DIR}/nativeModule"
  PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/sync_http"
)
if(_ps_native_includes)
  target_include_directories(powersync_lynx_native PRIVATE ${_ps_native_includes})
endif()
target_compile_definitions(powersync_lynx_native
  PUBLIC
    NAPI_VERSION=8
    USE_WEAK_SUFFIX_NAPI
  PRIVATE
    POWERSYNC_NO_STATIC_REGISTRATION
)
if(APPLE)
  target_link_libraries(powersync_lynx_native PRIVATE
    "-framework CoreFoundation"
    "-framework Foundation"
  )
elseif(WIN32)
  target_compile_definitions(powersync_lynx_native PRIVATE
    BUILDING_NODE_EXTENSION
    NOMINMAX
  )
  if(MSVC)
    target_compile_options(powersync_lynx_native PRIVATE /utf-8)
  endif()
  target_link_libraries(powersync_lynx_native PRIVATE shell32 ole32 winhttp)
endif()

# Stage powersync-sqlite-core alongside the consumer executable (or into Contents/Frameworks/
# for macOS .app bundles). Optional override:
#   powersync_lynx_copy_core(my_app)
#   powersync_lynx_copy_core(my_app /custom/path/to/core)
#   powersync_lynx_copy_core(my_app CORE_PATH /custom/path/to/core)
function(powersync_lynx_copy_core target)
  set(oneValueArgs CORE_PATH)
  cmake_parse_arguments(PS_COPY "" "${oneValueArgs}" "" ${ARGN})

  set(_core_src "${PS_COPY_CORE_PATH}")
  if(NOT _core_src AND PS_COPY_UNPARSED_ARGUMENTS)
    list(GET PS_COPY_UNPARSED_ARGUMENTS 0 _core_src)
  endif()
  if(NOT _core_src AND DEFINED POWERSYNC_CORE_BINARY AND POWERSYNC_CORE_BINARY)
    set(_core_src "${POWERSYNC_CORE_BINARY}")
  endif()
  if(NOT _core_src)
    if(APPLE)
      set(_core_src "${POWERSYNC_LYNX_ROOT}/dist/macos/arm64/libpowersync_aarch64.macos.dylib")
    elseif(WIN32)
      set(_core_src "${POWERSYNC_LYNX_ROOT}/dist/windows/x64/powersync_x64.dll")
    else()
      set(_core_src "${POWERSYNC_LYNX_ROOT}/dist/linux/x64/libpowersync_x64.linux.so")
    endif()
  endif()

  if(NOT EXISTS "${_core_src}")
    message(FATAL_ERROR
      "powersync_lynx_copy_core(${target}): powersync-sqlite-core binary not found at ${_core_src}. "
      "Run 'node scripts/fetch-native-deps.mjs --macos-arm64' (or --windows-x64) or pass CORE_PATH."
    )
  endif()

  get_filename_component(_core_name "${_core_src}" NAME)

  if(APPLE)
    get_target_property(_is_bundle "${target}" MACOSX_BUNDLE)
    if(_is_bundle)
      set(_dest_dir "$<TARGET_BUNDLE_CONTENT_DIR:${target}>/Frameworks")
    else()
      set(_dest_dir "$<TARGET_FILE_DIR:${target}>")
    endif()
  else()
    set(_dest_dir "$<TARGET_FILE_DIR:${target}>")
  endif()

  add_custom_command(
    TARGET "${target}" POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_dest_dir}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${_core_src}" "${_dest_dir}/${_core_name}"
    COMMENT "Staging ${_core_name} for ${target}"
    VERBATIM
  )
endfunction()

if(POWERSYNC_BUILD_LYNXTRON_NAPI)
  set(_ps_lynx_headers_root "")
  if(DEFINED LYNX_HEADERS_ROOT AND LYNX_HEADERS_ROOT)
    set(_ps_lynx_headers_root "${LYNX_HEADERS_ROOT}")
  elseif(DEFINED ENV{LYNX_HEADERS_ROOT} AND NOT "$ENV{LYNX_HEADERS_ROOT}" STREQUAL "")
    set(_ps_lynx_headers_root "$ENV{LYNX_HEADERS_ROOT}")
  elseif(EXISTS "${POWERSYNC_LYNX_ROOT}/native-vendor/node_modules/@lynx-js/lynx-library-headers/include")
    set(_ps_lynx_headers_root "${POWERSYNC_LYNX_ROOT}/native-vendor/node_modules/@lynx-js/lynx-library-headers")
  elseif(EXISTS "${POWERSYNC_LYNX_ROOT}/node_modules/@lynx-js/lynx-library-headers/include")
    set(_ps_lynx_headers_root "${POWERSYNC_LYNX_ROOT}/node_modules/@lynx-js/lynx-library-headers")
  endif()

  if(NOT _ps_lynx_headers_root OR NOT EXISTS "${_ps_lynx_headers_root}/include")
    message(FATAL_ERROR
      "Unable to locate @lynx-js/lynx-library-headers for powersync_lynx_napi. "
      "Pass -DLYNX_HEADERS_ROOT=/path/to/@lynx-js/lynx-library-headers or install native-vendor/."
    )
  endif()

  add_library(powersync_lynx_napi MODULE
    nativeModule/NativePowerSyncModule.cc
    nativeModule/NativeSyncHttpNapi.cc
    ${_ps_http_sources}
    "${POWERSYNC_LYNX_ROOT}/lynxtron/library_entry.cc"
  )
  target_link_libraries(powersync_lynx_napi PRIVATE ps_sql)
  target_include_directories(powersync_lynx_napi PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/nativeModule"
    "${CMAKE_CURRENT_LIST_DIR}/sync_http"
    "${_ps_lynx_headers_root}/include"
  )
  if(EXISTS "${_ps_lynx_headers_root}/include/third_party/weak-node-api/headers")
    target_include_directories(powersync_lynx_napi PRIVATE
      "${_ps_lynx_headers_root}/include/third_party/weak-node-api/headers"
    )
  endif()
  if(EXISTS "${POWERSYNC_LYNX_ROOT}/native-vendor/node_modules/@lynx-js/weak-node-api/headers")
    target_include_directories(powersync_lynx_napi PRIVATE
      "${POWERSYNC_LYNX_ROOT}/native-vendor/node_modules/@lynx-js/weak-node-api/headers"
    )
  endif()

  target_compile_definitions(powersync_lynx_napi PRIVATE NAPI_VERSION=8)
  set_source_files_properties(
    nativeModule/NativePowerSyncModule.cc
    nativeModule/NativeSyncHttpNapi.cc
    PROPERTIES COMPILE_DEFINITIONS "USE_WEAK_SUFFIX_NAPI"
  )
  set_target_properties(powersync_lynx_napi PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    OUTPUT_NAME "powersync-lynx"
  )

  if(APPLE)
    target_link_libraries(powersync_lynx_napi PRIVATE
      "-framework CoreFoundation"
      "-framework Foundation"
    )
    target_link_options(powersync_lynx_napi PRIVATE "-Wl,-undefined,dynamic_lookup")
  elseif(WIN32)
    target_compile_definitions(powersync_lynx_napi PRIVATE
      BUILDING_NODE_EXTENSION
      NOMINMAX
    )
    if(MSVC)
      target_compile_options(powersync_lynx_napi PRIVATE /utf-8)
    endif()
    target_link_libraries(powersync_lynx_napi PRIVATE shell32 ole32 winhttp)
    set(_ps_lynx_cmake "${_ps_lynx_headers_root}/cmake/lynx-library-headers.cmake")
    if(NOT EXISTS "${_ps_lynx_cmake}")
      message(FATAL_ERROR
        "Missing ${_ps_lynx_cmake}. Use @lynx-js/lynx-library-headers >= 0.0.31 for lynx_link_lynxtron_runtime."
      )
    endif()
    if(NOT DEFINED LYNX_LIBRARY_PACKAGE_ROOT)
      if(EXISTS "${POWERSYNC_LYNX_ROOT}/native-vendor/package.json")
        set(LYNX_LIBRARY_PACKAGE_ROOT "${POWERSYNC_LYNX_ROOT}/native-vendor")
      else()
        set(LYNX_LIBRARY_PACKAGE_ROOT "${POWERSYNC_LYNX_ROOT}")
      endif()
    endif()
    include("${_ps_lynx_cmake}")
    lynx_link_lynxtron_runtime(powersync_lynx_napi)
  endif()
endif()

option(POWERSYNC_BUILD_TESTS "Build native C++ unit tests" OFF)
if(POWERSYNC_BUILD_TESTS AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/tests/ps_sql_test.cc")
  set(_ps_fixtures_json "${POWERSYNC_LYNX_ROOT}/shared/fixtures/sync-stream.json")
  set(_ps_android_java_dir "${POWERSYNC_LYNX_ROOT}/android/src/main/java/com/powersync/lynx")

  add_executable(ps_sql_test tests/ps_sql_test.cc)
  target_link_libraries(ps_sql_test PRIVATE ps_sql)
  target_include_directories(ps_sql_test PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/nativeModule"
  )
  if(APPLE)
    target_link_libraries(ps_sql_test PRIVATE
      "-framework CoreFoundation"
      "-framework Foundation"
    )
  elseif(WIN32)
    target_compile_definitions(ps_sql_test PRIVATE NOMINMAX)
    target_link_libraries(ps_sql_test PRIVATE shell32 ole32)
  endif()
  if(MSVC)
    target_compile_options(ps_sql_test PRIVATE /utf-8)
  endif()

  add_executable(sync_http_engine_test
    tests/sync_http_engine_test.cc
    ${_ps_http_sources}
  )
  target_include_directories(sync_http_engine_test PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/sync_http"
    "${CMAKE_CURRENT_LIST_DIR}/tests"
  )
  target_compile_definitions(sync_http_engine_test PRIVATE
    PS_SYNC_STREAM_FIXTURES_PATH="${_ps_fixtures_json}"
  )
  if(APPLE)
    target_link_libraries(sync_http_engine_test PRIVATE "-framework Foundation")
  elseif(WIN32)
    target_compile_definitions(sync_http_engine_test PRIVATE NOMINMAX)
    target_link_libraries(sync_http_engine_test PRIVATE winhttp ws2_32)
  endif()
  if(UNIX)
    target_link_libraries(sync_http_engine_test PRIVATE pthread)
  endif()
  if(MSVC)
    target_compile_options(sync_http_engine_test PRIVATE /utf-8)
  endif()

  add_executable(sync_stream_fixtures_test tests/sync_stream_fixtures_test.cc)
  target_include_directories(sync_stream_fixtures_test PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/tests"
  )
  target_compile_definitions(sync_stream_fixtures_test PRIVATE
    PS_SYNC_STREAM_FIXTURES_PATH="${_ps_fixtures_json}"
  )
  if(WIN32)
    target_compile_definitions(sync_stream_fixtures_test PRIVATE NOMINMAX)
    target_link_libraries(sync_stream_fixtures_test PRIVATE ws2_32)
  endif()
  if(UNIX)
    target_link_libraries(sync_stream_fixtures_test PRIVATE pthread)
  endif()
  if(MSVC)
    target_compile_options(sync_stream_fixtures_test PRIVATE /utf-8)
  endif()

  add_executable(sync_http_session_test
    tests/sync_http_session_test.cc
    sync_http/sync_http_session.cc
  )
  target_include_directories(sync_http_session_test PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/sync_http"
  )
  target_compile_definitions(sync_http_session_test PRIVATE
    PS_SYNC_STREAM_FIXTURES_PATH="${_ps_fixtures_json}"
  )
  if(UNIX)
    target_link_libraries(sync_http_session_test PRIVATE pthread)
  endif()
  if(MSVC)
    target_compile_options(sync_http_session_test PRIVATE /utf-8)
  endif()
endif()
