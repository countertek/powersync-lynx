cmake_minimum_required(VERSION 3.22)
project(powersync_lynx_native LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(SQLITE_DIR "${CMAKE_CURRENT_LIST_DIR}/../third_party/sqlite")
add_library(ps_sql STATIC
  ps_sql.cc
  "${SQLITE_DIR}/sqlite3.c"
)
target_include_directories(ps_sql PUBLIC "${CMAKE_CURRENT_LIST_DIR}" "${SQLITE_DIR}")
target_compile_definitions(ps_sql PRIVATE
  SQLITE_THREADSAFE=1
  SQLITE_ENABLE_LOAD_EXTENSION=1
  SQLITE_DQS=0
  SQLITE_ENABLE_FTS5=1
  SQLITE_ENABLE_JSON1=1
  SQLITE_ENABLE_MATH_FUNCTIONS=1
  SQLITE_USE_URI=1
)

if(UNIX AND NOT APPLE)
  target_link_libraries(ps_sql PUBLIC pthread dl)
elseif(APPLE)
  target_link_libraries(ps_sql PUBLIC pthread dl)
endif()

add_library(powersync_lynx_napi MODULE
  nativeModule/NativePowerSyncModule.cc
  "${CMAKE_CURRENT_LIST_DIR}/../lynxtron/library_entry.cc"
)
target_link_libraries(powersync_lynx_napi PRIVATE ps_sql)
target_include_directories(powersync_lynx_napi PRIVATE
  "${CMAKE_CURRENT_LIST_DIR}"
  "${CMAKE_CURRENT_LIST_DIR}/nativeModule"
  "${CMAKE_CURRENT_LIST_DIR}/../native-vendor/node_modules/@lynx-js/weak-node-api/headers"
  "${CMAKE_CURRENT_LIST_DIR}/../native-vendor/node_modules/@lynx-js/lynx-library-headers/include"
)
target_compile_definitions(powersync_lynx_napi PRIVATE NAPI_VERSION=8)
set_source_files_properties(nativeModule/NativePowerSyncModule.cc PROPERTIES
  COMPILE_DEFINITIONS "USE_WEAK_SUFFIX_NAPI"
)
set_target_properties(powersync_lynx_napi PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "powersync-lynx"
)
if(APPLE)
  target_link_options(powersync_lynx_napi PRIVATE "-Wl,-undefined,dynamic_lookup")
endif()
if(WIN32)
  target_sources(powersync_lynx_napi PRIVATE win_host_stubs.c)
endif()
