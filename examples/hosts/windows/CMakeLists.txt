cmake_minimum_required(VERSION 3.22)

if(NOT WIN32)
  message(FATAL_ERROR "examples/hosts/windows must be configured on Windows (x64 MSVC).")
endif()

project(PowerSyncLynxShowcaseWindows LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

get_filename_component(POWERSYNC_LYNX_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)

# Resolve Lynx Desktop C++ SDK directory:
# 1. -DLYNX_SDK_DIR=...
# 2. ENV{LYNX_SDK_DIR}
# 3. Default repo cache populated by `node scripts/fetch-lynx-desktop-sdk.mjs --windows-x64`
set(_lynx_sdk_dir "")
if(DEFINED LYNX_SDK_DIR AND NOT "${LYNX_SDK_DIR}" STREQUAL "")
  set(_lynx_sdk_dir "${LYNX_SDK_DIR}")
elseif(DEFINED ENV{LYNX_SDK_DIR} AND NOT "$ENV{LYNX_SDK_DIR}" STREQUAL "")
  set(_lynx_sdk_dir "$ENV{LYNX_SDK_DIR}")
else()
  set(_lynx_sdk_dir "${POWERSYNC_LYNX_ROOT}/third_party/lynx-sdk/windows-x64")
endif()
get_filename_component(_lynx_sdk_dir "${_lynx_sdk_dir}" ABSOLUTE)

if(NOT EXISTS "${_lynx_sdk_dir}/include/lynx_view.h"
   OR NOT EXISTS "${_lynx_sdk_dir}/lib/lynx.dll.lib"
   OR NOT EXISTS "${_lynx_sdk_dir}/lib/lynx.dll")
  message(FATAL_ERROR
    "Lynx Desktop Windows x64 SDK not found at ${_lynx_sdk_dir}.\n"
    "Run: node scripts/fetch-lynx-desktop-sdk.mjs --windows-x64\n"
    "Or pass -DLYNX_SDK_DIR=/path/to/lynx-sdk (or set LYNX_SDK_DIR)."
  )
endif()

set(LYNX_SDK_DIR "${_lynx_sdk_dir}" CACHE PATH "Path to Lynx Desktop C++ SDK" FORCE)

if(NOT EXISTS "${POWERSYNC_LYNX_ROOT}/third_party/sqlite/sqlite3.c")
  message(FATAL_ERROR
    "SQLite amalgamation not found under ${POWERSYNC_LYNX_ROOT}/third_party/sqlite/.\n"
    "Run: node scripts/fetch-native-deps.mjs --windows-x64"
  )
endif()

set(POWERSYNC_SHOWCASE_BUNDLE
  "${POWERSYNC_LYNX_ROOT}/examples/showcase/lynx-dist/main.lynx.bundle"
  CACHE FILEPATH "Path to showcase main.lynx.bundle"
)

# Link powersync-lynx native target (no Lynxtron N-API, no native-vendor/).
set(POWERSYNC_BUILD_LYNXTRON_NAPI OFF CACHE BOOL "" FORCE)
add_subdirectory(
  "${POWERSYNC_LYNX_ROOT}/shared"
  "${CMAKE_CURRENT_BINARY_DIR}/powersync_shared"
)

add_executable(PowerSyncLynxShowcase
  src/main.cc
  src/HostConfig.h
  src/HostConfig.cc
  src/ShowcaseHttpService.h
  src/ShowcaseHttpService.cc
  src/ShowcaseResourceFetcher.h
  src/ShowcaseResourceFetcher.cc
)

target_include_directories(PowerSyncLynxShowcase PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${POWERSYNC_LYNX_ROOT}/shared"
  "${LYNX_SDK_DIR}/include"
  "${LYNX_SDK_DIR}/include/third_party/weak-node-api/headers"
)

target_compile_definitions(PowerSyncLynxShowcase PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
  POWERSYNC_DEFAULT_BUNDLE_PATH="${POWERSYNC_SHOWCASE_BUNDLE}"
)

if(MSVC)
  target_compile_options(PowerSyncLynxShowcase PRIVATE /utf-8 /W3)
endif()

target_link_libraries(PowerSyncLynxShowcase PRIVATE
  powersync_lynx_native
  "${LYNX_SDK_DIR}/lib/lynx.dll.lib"
  user32
  gdi32
  shell32
  winhttp
)

# Stage powersync_x64.dll next to PowerSyncLynxShowcase.exe.
powersync_lynx_copy_core(PowerSyncLynxShowcase)

# Stage lynx.dll, lynx_core*.js, and data/icudtl.dat next to PowerSyncLynxShowcase.exe.
add_custom_command(
  TARGET PowerSyncLynxShowcase POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different
    "${LYNX_SDK_DIR}/lib/lynx.dll"
    "$<TARGET_FILE_DIR:PowerSyncLynxShowcase>/lynx.dll"
  COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_FILE_DIR:PowerSyncLynxShowcase>/data"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different
    "${LYNX_SDK_DIR}/data/icudtl.dat"
    "$<TARGET_FILE_DIR:PowerSyncLynxShowcase>/data/icudtl.dat"
  COMMENT "Staging lynx.dll and data/icudtl.dat next to PowerSyncLynxShowcase.exe"
  VERBATIM
)

if(EXISTS "${LYNX_SDK_DIR}/lynx_core.js")
  add_custom_command(
    TARGET PowerSyncLynxShowcase POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${LYNX_SDK_DIR}/lynx_core.js"
      "$<TARGET_FILE_DIR:PowerSyncLynxShowcase>/lynx_core.js"
    COMMENT "Staging lynx_core.js next to PowerSyncLynxShowcase.exe"
    VERBATIM
  )
endif()

if(EXISTS "${LYNX_SDK_DIR}/lynx_core_dev.js")
  add_custom_command(
    TARGET PowerSyncLynxShowcase POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${LYNX_SDK_DIR}/lynx_core_dev.js"
      "$<TARGET_FILE_DIR:PowerSyncLynxShowcase>/lynx_core_dev.js"
    COMMENT "Staging lynx_core_dev.js next to PowerSyncLynxShowcase.exe"
    VERBATIM
  )
endif()

if(EXISTS "${POWERSYNC_SHOWCASE_BUNDLE}")
  add_custom_command(
    TARGET PowerSyncLynxShowcase POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${POWERSYNC_SHOWCASE_BUNDLE}"
      "$<TARGET_FILE_DIR:PowerSyncLynxShowcase>/main.lynx.bundle"
    COMMENT "Copying showcase main.lynx.bundle next to PowerSyncLynxShowcase.exe"
    VERBATIM
  )
else()
  message(WARNING
    "Showcase bundle not found at ${POWERSYNC_SHOWCASE_BUNDLE}. "
    "Build it with 'pnpm --dir examples/showcase build' (or pass --bundle at launch)."
  )
endif()
