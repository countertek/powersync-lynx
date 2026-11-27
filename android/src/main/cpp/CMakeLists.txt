cmake_minimum_required(VERSION 3.22)
project(powersync_lynx_sql LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT DEFINED POWERSYNC_LYNX_ROOT)
  get_filename_component(POWERSYNC_LYNX_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../../../.." ABSOLUTE)
endif()

set(SQLITE_DIR "${POWERSYNC_LYNX_ROOT}/third_party/sqlite")
set(SHARED_DIR "${POWERSYNC_LYNX_ROOT}/shared")

add_library(powersync_lynx_sql SHARED
  jni_runtime.cc
  ps_sql_jni.cc
  sync_http_session_jni.cc
  "${SHARED_DIR}/ps_sql.cc"
  "${SHARED_DIR}/sync_http/sync_http_session.cc"
  "${SQLITE_DIR}/sqlite3.c"
)

target_include_directories(powersync_lynx_sql PRIVATE
  "${SHARED_DIR}"
  "${SHARED_DIR}/sync_http"
  "${SQLITE_DIR}"
)

target_compile_definitions(powersync_lynx_sql PRIVATE
  SQLITE_THREADSAFE=1
  SQLITE_ENABLE_LOAD_EXTENSION=1
  SQLITE_DQS=0
  SQLITE_ENABLE_FTS5=1
  SQLITE_ENABLE_JSON1=1
  SQLITE_ENABLE_MATH_FUNCTIONS=1
  SQLITE_USE_URI=1
  SQLITE_DEFAULT_MEMSTATUS=0
  SQLITE_OMIT_DEPRECATED=1
)

find_package(powersync_sqlite_core REQUIRED CONFIG)
find_library(log-lib log)
# Link libpowersync.so alongside libdl.so so bionic places libdl.so in the same
# local_group when loading libpowersync.so (required on Android 16+/17 with
# targetSdk >= 36 because upstream libpowersync.so references dlsym without
# listing libdl.so in its own DT_NEEDED).
target_link_libraries(powersync_lynx_sql PRIVATE
  ${log-lib}
  dl
  android
  -Wl,--no-as-needed
  powersync_sqlite_core::powersync
  -Wl,--as-needed
)
