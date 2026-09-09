# Autolink 4.0 looks up Class.forName("<packageName>.LynxLibraryProviderImpl").
-keep class com.powersync.lynx.LynxLibraryProviderImpl { *; }

# JS bridge invokes NativePowerSyncModule methods by name (SQL RPC + Native Module HTTP).
-keep class com.powersync.lynx.NativePowerSyncModule { *; }
-keep class com.powersync.lynx.NativeSyncHttp { *; }
-keep class com.powersync.lynx.PsSqlEngine { *; }
