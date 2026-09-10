/**
 * Autolink/CocoaPods compile unit for the shared SQLite engine.
 *
 * CocoaPods does not add `source_files` outside PODS_TARGET_SRCROOT (the ios/
 * directory) to Pods.xcodeproj — `../shared/ps_sql.cc` is silently dropped.
 * This translation unit lives under the pod root so it is compiled. The
 * implementation remains the single canonical source `shared/ps_sql.cc`.
 * Do not put engine logic here.
 */
#include "ps_sql.cc"
