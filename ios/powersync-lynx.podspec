Pod::Spec.new do |s|
  s.name         = 'powersync-lynx'
  s.version      = '0.0.0'
  s.summary      = 'Lynx NativePowerSyncModule'
  s.homepage     = 'https://github.com/countertek/powersync-for-lynxjs'
  s.license      = { :type => 'Apache-2.0' }
  s.author       = 'PowerSync'
  s.platform     = :ios, '15.0'
  s.source       = { :path => '.' }
  # CocoaPods drops source_files outside PODS_TARGET_SRCROOT (the ios/ dir).
  # Compile shared/ps_sql.cc via src/ps_sql_engine.cc (include), not ../shared in
  # this glob. sqlite amalgamation is materialized into src/ by fetch-native-deps.
  # Keep leftover ios/src/ps_sql.{cc,h} copies out of the target (canonical is shared/).
  s.source_files = 'src/**/*.{h,m,mm,c,cc}'
  s.exclude_files = 'src/ps_sql.{cc,h}'
  s.preserve_paths = '../shared/ps_sql.cc', '../shared/ps_sql.h'
  s.dependency 'Lynx'
  s.dependency 'powersync-sqlite-core', '0.5.3'
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/src" "$(PODS_TARGET_SRCROOT)/../shared" "$(PODS_TARGET_SRCROOT)/../third_party/sqlite"',
    'GCC_PREPROCESSOR_DEFINITIONS' => 'PS_SQL_LINK_CORE=1 SQLITE_THREADSAFE=1 SQLITE_ENABLE_FTS5=1 SQLITE_ENABLE_JSON1=1 SQLITE_ENABLE_MATH_FUNCTIONS=1 SQLITE_USE_URI=1 SQLITE_DQS=0 SQLITE_DEFAULT_MEMSTATUS=0 SQLITE_OMIT_DEPRECATED=1 $(inherited)',
    'OTHER_CFLAGS' => '-DSQLITE_THREADSAFE=1'
  }
  s.prepare_command = 'node ../scripts/fetch-native-deps.mjs'
end
