Pod::Spec.new do |s|
  s.name         = 'powersync-lynx'
  s.version      = '0.0.0'
  s.summary      = 'Lynx NativePowerSyncModule'
  s.homepage     = 'https://github.com/countertek/powersync-for-lynxjs'
  s.license      = { :type => 'Apache-2.0' }
  s.author       = 'PowerSync'
  s.platform     = :ios, '15.0'
  s.source       = { :path => '.' }
  s.source_files = 'ios/src/**/*.{h,m,mm}', 'shared/ps_sql.{h,cc}', 'third_party/sqlite/sqlite3.{c,h}'
  s.exclude_files = 'shared/nativeModule/**/*', 'shared/tests/**/*'
  s.dependency 'Lynx'
  s.dependency 'powersync-sqlite-core', '0.5.3'
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/shared" "$(PODS_TARGET_SRCROOT)/third_party/sqlite"',
    'GCC_PREPROCESSOR_DEFINITIONS' => 'PS_SQL_LINK_CORE=1 SQLITE_THREADSAFE=1 SQLITE_ENABLE_FTS5=1 SQLITE_ENABLE_JSON1=1 SQLITE_ENABLE_MATH_FUNCTIONS=1 SQLITE_USE_URI=1 SQLITE_DQS=0 SQLITE_DEFAULT_MEMSTATUS=0 SQLITE_OMIT_DEPRECATED=1 $(inherited)',
    'OTHER_CFLAGS' => '-DSQLITE_THREADSAFE=1'
  }
  s.prepare_command = 'node scripts/fetch-native-deps.mjs'
end
