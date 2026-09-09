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
  ps_sql_jni.cc
  utf8_hold_jni.cc
  "${SHARED_DIR}/ps_sql.cc"
  "${SQLITE_DIR}/sqlite3.c"
)

target_include_directories(powersync_lynx_sql PRIVATE
  "${SHARED_DIR}"
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

find_library(log-lib log)
target_link_libraries(powersync_lynx_sql PRIVATE ${log-lib} dl android)
