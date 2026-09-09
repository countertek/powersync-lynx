# Autolink 4.0 looks up Class.forName("<packageName>.LynxLibraryProviderImpl").
-keep class com.powersync.lynx.LynxLibraryProviderImpl { *; }

# JS bridge invokes NativePowerSyncModule methods by name (SQL RPC + httpFetch).
-keep class com.powersync.lynx.NativePowerSyncModule { *; }
