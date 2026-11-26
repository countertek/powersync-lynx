cmake_minimum_required(VERSION 3.22)

if(NOT APPLE)
  message(FATAL_ERROR "examples/hosts/macos must be configured on macOS.")
endif()

set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0" CACHE STRING "Minimum macOS deployment target")
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "macOS target architecture")

project(PowerSyncLynxShowcaseMacOS LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

get_filename_component(POWERSYNC_LYNX_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)

# Resolve Lynx Desktop C++ SDK directory:
# 1. -DLYNX_SDK_DIR=...
# 2. ENV{LYNX_SDK_DIR}
# 3. Default repo cache populated by `node scripts/fetch-lynx-desktop-sdk.mjs --macos-arm64`
set(_lynx_sdk_dir "")
if(DEFINED LYNX_SDK_DIR AND NOT "${LYNX_SDK_DIR}" STREQUAL "")
  set(_lynx_sdk_dir "${LYNX_SDK_DIR}")
elseif(DEFINED ENV{LYNX_SDK_DIR} AND NOT "$ENV{LYNX_SDK_DIR}" STREQUAL "")
  set(_lynx_sdk_dir "$ENV{LYNX_SDK_DIR}")
else()
  set(_lynx_sdk_dir "${POWERSYNC_LYNX_ROOT}/third_party/lynx-sdk/macos-arm64")
endif()
get_filename_component(_lynx_sdk_dir "${_lynx_sdk_dir}" ABSOLUTE)

if(NOT EXISTS "${_lynx_sdk_dir}/include/lynx_view.h" OR NOT EXISTS "${_lynx_sdk_dir}/lib/libLynx.dylib")
  message(FATAL_ERROR
    "Lynx Desktop macOS SDK not found at ${_lynx_sdk_dir}.\n"
    "Run: node scripts/fetch-lynx-desktop-sdk.mjs --macos-arm64\n"
    "Or pass -DLYNX_SDK_DIR=/path/to/lynx-sdk (or set LYNX_SDK_DIR)."
  )
endif()

set(LYNX_SDK_DIR "${_lynx_sdk_dir}" CACHE PATH "Path to Lynx Desktop C++ SDK" FORCE)

if(NOT EXISTS "${POWERSYNC_LYNX_ROOT}/third_party/sqlite/sqlite3.c")
  message(FATAL_ERROR
    "SQLite amalgamation not found under ${POWERSYNC_LYNX_ROOT}/third_party/sqlite/.\n"
    "Run: node scripts/fetch-native-deps.mjs --macos-arm64"
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

add_executable(PowerSyncLynxShowcase MACOSX_BUNDLE
  src/main.mm
  src/AppDelegate.h
  src/AppDelegate.mm
  src/HostConfig.h
  src/HostConfig.mm
  src/ShowcaseHttpService.h
  src/ShowcaseHttpService.mm
  src/ShowcaseResourceFetcher.h
  src/ShowcaseResourceFetcher.mm
)

set_target_properties(PowerSyncLynxShowcase PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in"
  MACOSX_BUNDLE_GUI_IDENTIFIER "com.powersync.lynx.showcase"
  MACOSX_BUNDLE_BUNDLE_NAME "PowerSyncLynxShowcase"
  MACOSX_BUNDLE_SHORT_VERSION_STRING "0.3.0"
  MACOSX_BUNDLE_BUNDLE_VERSION "1"
  BUILD_WITH_INSTALL_RPATH TRUE
  INSTALL_RPATH "@executable_path/../Frameworks"
)

target_compile_options(PowerSyncLynxShowcase PRIVATE
  $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>
)

target_include_directories(PowerSyncLynxShowcase PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${LYNX_SDK_DIR}/include"
  "${LYNX_SDK_DIR}/include/third_party/weak-node-api/headers"
)

target_compile_definitions(PowerSyncLynxShowcase PRIVATE
  POWERSYNC_DEFAULT_BUNDLE_PATH="${POWERSYNC_SHOWCASE_BUNDLE}"
)

target_link_libraries(PowerSyncLynxShowcase PRIVATE
  powersync_lynx_native
  "${LYNX_SDK_DIR}/lib/libLynx.dylib"
  "-framework Cocoa"
  "-framework Foundation"
  "-framework QuartzCore"
)

# Stage libpowersync_aarch64.macos.dylib into Contents/Frameworks/.
powersync_lynx_copy_core(PowerSyncLynxShowcase)

# Stage libLynx.dylib, ICU data, and Lynx resource bundles into the .app bundle.
add_custom_command(
  TARGET PowerSyncLynxShowcase POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Frameworks"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different
    "${LYNX_SDK_DIR}/lib/libLynx.dylib"
    "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Frameworks/libLynx.dylib"
  COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Resources/data"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different
    "${LYNX_SDK_DIR}/data/icudtl.dat"
    "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Resources/data/icudtl.dat"
  COMMENT "Staging libLynx.dylib and icudtl.dat into PowerSyncLynxShowcase.app"
  VERBATIM
)

if(EXISTS "${LYNX_SDK_DIR}/bundles/LynxResources.bundle")
  add_custom_command(
    TARGET PowerSyncLynxShowcase POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
      "${LYNX_SDK_DIR}/bundles/LynxResources.bundle"
      "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Resources/LynxResources.bundle"
    COMMENT "Staging LynxResources.bundle into PowerSyncLynxShowcase.app"
    VERBATIM
  )
endif()

if(EXISTS "${LYNX_SDK_DIR}/bundles/LynxDebugResources.bundle")
  add_custom_command(
    TARGET PowerSyncLynxShowcase POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
      "${LYNX_SDK_DIR}/bundles/LynxDebugResources.bundle"
      "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Resources/LynxDebugResources.bundle"
    COMMENT "Staging LynxDebugResources.bundle into PowerSyncLynxShowcase.app"
    VERBATIM
  )
endif()

if(EXISTS "${POWERSYNC_SHOWCASE_BUNDLE}")
  add_custom_command(
    TARGET PowerSyncLynxShowcase POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${POWERSYNC_SHOWCASE_BUNDLE}"
      "$<TARGET_BUNDLE_CONTENT_DIR:PowerSyncLynxShowcase>/Resources/main.lynx.bundle"
    COMMENT "Copying showcase main.lynx.bundle into PowerSyncLynxShowcase.app"
    VERBATIM
  )
else()
  message(WARNING
    "Showcase bundle not found at ${POWERSYNC_SHOWCASE_BUNDLE}. "
    "Build it with 'pnpm --dir examples/showcase build' (or pass --bundle at launch)."
  )
endif()
