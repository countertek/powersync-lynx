cmake_minimum_required(VERSION 3.22)
project(powersync_lynx_lynxtron LANGUAGES C CXX)
set(POWERSYNC_BUILD_LYNXTRON_NAPI ON CACHE BOOL "Build the Lynxtron N-API .node module")
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../shared" powersync_shared)
