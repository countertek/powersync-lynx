SQLITE_DIR := third_party/sqlite
SQLITE_FLAGS := -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_LOAD_EXTENSION=1 \
	-DSQLITE_DQS=0 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_JSON1 \
	-DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_USE_URI=1 \
	-DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_OMIT_DEPRECATED
CXXFLAGS := -std=c++17 -fPIC -O2 -Ishared -I$(SQLITE_DIR)
CFLAGS := -std=c11 -fPIC -O2 -I$(SQLITE_DIR) $(SQLITE_FLAGS)
LDFLAGS := -ldl -lpthread

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),Linux)
  CORE_DYLIB := dist/linux/x64/libpowersync_x64.linux.so
else ifeq ($(UNAME_S),Darwin)
  ifeq ($(UNAME_M),arm64)
    CORE_DYLIB := dist/macos/arm64/libpowersync_aarch64.macos.dylib
  else
    CORE_DYLIB := dist/macos/x64/libpowersync_x64.macos.dylib
  endif
else
  CORE_DYLIB := dist/macos/arm64/libpowersync_aarch64.macos.dylib
endif
TEST_BIN := shared/build/ps_sql_test
FIXTURE_TEST_BIN := shared/build/sync_stream_fixtures_test
POLICY_ANDROID_TEST_BIN := shared/build/sync_http_policy_android_test
UTF8_HOLD_TEST_BIN := shared/build/utf8_hold_test
SESSION_TEST_BIN := shared/build/sync_http_session_test
IOS_TEST_BIN := shared/build/ios_module_rpc_test
ANDROID_JAVA_DIR := $(CURDIR)/android/src/main/java/com/powersync/lynx
FIXTURES_JSON := $(CURDIR)/shared/fixtures/sync-stream.json
NODE := dist/macos/arm64/powersync-lynx.node
WIN_NODE := dist/windows/x64/powersync-lynx.node
ZIG ?= $(shell command -v zig 2>/dev/null)
# package.json packageManager is pnpm@12.3.4.
# Prefer pnpm 12 on PATH (Corepack or a local install). Do not use the npm CLI.
PNPM_PIN := 12.3.4
PNPM ?= $(shell \
	bin=$$(command -v pnpm 2>/dev/null); \
	if [ -n "$$bin" ] && "$$bin" --version 2>/dev/null | grep -q '^12\.'; then \
		printf '%s\n' "$$bin"; \
	elif command -v corepack >/dev/null 2>&1; then \
		printf 'corepack pnpm@%s\n' "$(PNPM_PIN)"; \
	else \
		printf '%s\n' "pnpm"; \
	fi)

JAVA_HOME ?= $(shell dirname $$(dirname $$(readlink -f $$(command -v java))))
JNI_CFLAGS := -I$(JAVA_HOME)/include -I$(JAVA_HOME)/include/linux
JNI_OBJ := shared/build/ps_sql_jni.o
JNI_UTF8_OBJ := shared/build/utf8_hold_jni.o
JNI_SESSION_OBJ := shared/build/sync_http_session_jni.o

ANDROID_SDK ?= $(ANDROID_HOME)
ADB := $(ANDROID_SDK)/platform-tools/adb
EMULATOR := $(ANDROID_SDK)/emulator/emulator
ANDROID_AVD ?= Pixel_10_Pro

.PHONY: deps test test-ios test-android node win-node all

all: test node

deps:
	node scripts/fetch-native-deps.mjs

$(SQLITE_DIR)/sqlite3.c:
	node scripts/fetch-native-deps.mjs

$(SQLITE_DIR)/sqlite3.o: $(SQLITE_DIR)/sqlite3.c
	$(CC) $(CFLAGS) -c $< -o $@

shared/build/ps_sql.o: shared/ps_sql.cc shared/ps_sql.h $(SQLITE_DIR)/sqlite3.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) -c shared/ps_sql.cc -o $@

$(TEST_BIN): shared/build/ps_sql.o $(SQLITE_DIR)/sqlite3.o shared/tests/ps_sql_test.cc
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) shared/tests/ps_sql_test.cc \
		shared/build/ps_sql.o $(SQLITE_DIR)/sqlite3.o $(LDFLAGS) -o $@

$(FIXTURE_TEST_BIN): shared/tests/sync_stream_fixtures_test.cc \
		shared/sync_stream_fixtures.h shared/tests/ndjson_http_replay.h \
		shared/sync_http_policy.h shared/fixtures/sync-stream.json
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/tests \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		shared/tests/sync_stream_fixtures_test.cc $(LDFLAGS) -o $@

$(POLICY_ANDROID_TEST_BIN): shared/tests/sync_http_policy_android_test.cc \
		shared/sync_http_policy.h \
		android/src/main/java/com/powersync/lynx/SyncHttpPolicy.java \
		android/src/main/java/com/powersync/lynx/IdleCompleteHttp.java \
		android/src/main/java/com/powersync/lynx/StreamingHttp.java \
		android/src/main/java/com/powersync/lynx/NativeSyncHttp.java
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) \
		-DPS_SYNC_HTTP_POLICY_H_PATH='"$(CURDIR)/shared/sync_http_policy.h"' \
		-DPS_ANDROID_JAVA_DIR='"$(ANDROID_JAVA_DIR)"' \
		shared/tests/sync_http_policy_android_test.cc -o $@

$(UTF8_HOLD_TEST_BIN): shared/tests/utf8_hold_test.cc shared/utf8_hold.h \
		shared/sync_stream_fixtures.h shared/fixtures/sync-stream.json \
		android/src/main/java/com/powersync/lynx/StreamingHttp.java \
		android/src/main/cpp/utf8_hold_jni.cc \
		ios/src/StreamingHttp.mm
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		-DPS_ANDROID_STREAMING_HTTP_JAVA='"$(ANDROID_JAVA_DIR)/StreamingHttp.java"' \
		-DPS_IOS_STREAMING_HTTP_MM='"$(CURDIR)/ios/src/StreamingHttp.mm"' \
		-DPS_ANDROID_UTF8_HOLD_JNI='"$(CURDIR)/android/src/main/cpp/utf8_hold_jni.cc"' \
		shared/tests/utf8_hold_test.cc -o $@

$(SESSION_TEST_BIN): shared/tests/sync_http_session_test.cc shared/sync_http_session.h \
		shared/sync_http_policy.h \
		android/src/main/java/com/powersync/lynx/NativeSyncHttp.java \
		android/src/main/java/com/powersync/lynx/SyncHttpSession.java \
		android/src/main/cpp/sync_http_session_jni.cc \
		ios/src/NativeSyncHttp.mm \
		shared/nativeModule/NativePowerSyncModule.cc
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) \
		-DPS_ANDROID_NATIVE_SYNC_HTTP_JAVA='"$(ANDROID_JAVA_DIR)/NativeSyncHttp.java"' \
		-DPS_ANDROID_SYNC_HTTP_SESSION_JAVA='"$(ANDROID_JAVA_DIR)/SyncHttpSession.java"' \
		-DPS_IOS_NATIVE_SYNC_HTTP_MM='"$(CURDIR)/ios/src/NativeSyncHttp.mm"' \
		-DPS_ANDROID_SESSION_JNI='"$(CURDIR)/android/src/main/cpp/sync_http_session_jni.cc"' \
		-DPS_DESKTOP_NATIVE_MODULE_CC='"$(CURDIR)/shared/nativeModule/NativePowerSyncModule.cc"' \
		shared/tests/sync_http_session_test.cc -o $@

test: deps $(TEST_BIN) $(FIXTURE_TEST_BIN) $(POLICY_ANDROID_TEST_BIN) $(UTF8_HOLD_TEST_BIN) \
		$(SESSION_TEST_BIN) $(JNI_OBJ) $(JNI_UTF8_OBJ) $(JNI_SESSION_OBJ)
	@! grep -n 'UIApplication.sharedApplication.windows' ios/src/NativeSyncHttp.mm
	@! grep -n 'findLynxViewIn' ios/src/NativeSyncHttp.mm
	POWERSYNC_CORE_PATH="$(CURDIR)/$(CORE_DYLIB)" $(TEST_BIN)
	PS_SYNC_STREAM_FIXTURES_PATH="$(FIXTURES_JSON)" $(FIXTURE_TEST_BIN)
	$(POLICY_ANDROID_TEST_BIN)
	$(UTF8_HOLD_TEST_BIN)
	$(SESSION_TEST_BIN)
	node scripts/gen-sync-http-policy-java.mjs --check

$(JNI_OBJ): android/src/main/cpp/ps_sql_jni.cc shared/ps_sql.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) $(JNI_CFLAGS) -c android/src/main/cpp/ps_sql_jni.cc -o $@

$(JNI_UTF8_OBJ): android/src/main/cpp/utf8_hold_jni.cc shared/utf8_hold.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(JNI_CFLAGS) -c android/src/main/cpp/utf8_hold_jni.cc -o $@

$(JNI_SESSION_OBJ): android/src/main/cpp/sync_http_session_jni.cc shared/sync_http_session.h \
		shared/sync_http_policy.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(JNI_CFLAGS) -c android/src/main/cpp/sync_http_session_jni.cc -o $@

$(IOS_TEST_BIN): deps ios/tests/ios_module_rpc_test.mm ios/tests/ios_sync_http_fixture_test.mm \
		ios/tests/ios_sync_http_fixtures.h \
		ios/src/NativePowerSyncModule.mm \
		ios/src/NativePowerSyncModule.h ios/src/NativeSyncHttp.mm ios/src/NativeSyncHttp.h \
		ios/src/IdleCompleteHttp.mm ios/src/IdleCompleteHttp.h \
		ios/src/StreamingHttp.mm ios/src/StreamingHttp.h \
		shared/sync_http_policy.h shared/utf8_hold.h shared/sync_http_session.h \
		shared/sync_stream_fixtures.h \
		shared/tests/ndjson_http_replay.h shared/fixtures/sync-stream.json \
		shared/ps_sql.cc shared/ps_sql.h \
		$(SQLITE_DIR)/sqlite3.o $(CORE_DYLIB)
	mkdir -p shared/build/ios-src
	sed 's/@LynxNativeModule("[^"]*")//' ios/src/NativePowerSyncModule.h \
		> shared/build/ios-src/NativePowerSyncModule.h
	cp ios/src/NativePowerSyncModule.mm shared/build/ios-src/NativePowerSyncModule.mm
	cp ios/src/NativeSyncHttp.h ios/src/NativeSyncHttp.mm shared/build/ios-src/
	cp ios/src/IdleCompleteHttp.h ios/src/IdleCompleteHttp.mm shared/build/ios-src/
	cp ios/src/StreamingHttp.h ios/src/StreamingHttp.mm shared/build/ios-src/
	clang++ -std=c++17 -fPIC -O2 -fobjc-arc -fblocks \
		-Ishared/build/ios-src -Iios/tests -Iios/tests/stubs -Ishared -Ishared/tests -I$(SQLITE_DIR) \
		$(SQLITE_FLAGS) -DPS_SQL_LINK_CORE=1 \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		ios/tests/ios_module_rpc_test.mm ios/tests/ios_sync_http_fixture_test.mm \
		shared/build/ios-src/NativePowerSyncModule.mm \
		shared/build/ios-src/NativeSyncHttp.mm \
		shared/build/ios-src/IdleCompleteHttp.mm \
		shared/build/ios-src/StreamingHttp.mm \
		shared/ps_sql.cc $(SQLITE_DIR)/sqlite3.o \
		$(CORE_DYLIB) -framework Foundation $(LDFLAGS) \
		-Wl,-rpath,$(CURDIR)/dist/macos/arm64 \
		-o $@
	core_id=$$(otool -D "$(CORE_DYLIB)" | awk 'NR==2 { print; exit }'); \
	test -n "$$core_id"; \
	install_name_tool -change "$$core_id" "$(CURDIR)/$(CORE_DYLIB)" $@

test-ios: $(IOS_TEST_BIN)
	$(IOS_TEST_BIN)

test-android: android/host/gradlew
	@if ! "$(ADB)" devices | awk 'NR>1 && $$2=="device"{found=1} END{exit !found}'; then \
		echo "starting $(ANDROID_AVD)"; \
		"$(EMULATOR)" -avd "$(ANDROID_AVD)" -no-window -no-audio -no-boot-anim -gpu auto >/tmp/powersync-lynx-emulator.log 2>&1 & \
		"$(ADB)" wait-for-device; \
		until [ "$$("$(ADB)" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done; \
	fi
	cd android/host && ./gradlew connectedDebugAndroidTest

NODE_VENDOR := native-vendor/node_modules
NAPI_INCLUDE := -I$(NODE_VENDOR)/@lynx-js/weak-node-api/headers \
	-I$(NODE_VENDOR)/@lynx-js/lynx-library-headers/include \
	-I$(NODE_VENDOR)/@lynx-js/lynx-library-headers/include/third_party/weak-node-api/headers

$(NODE_VENDOR):
	mkdir -p native-vendor
	cd native-vendor && $(PNPM) init >/dev/null 2>&1 || true
	cd native-vendor && $(PNPM) add --ignore-scripts \
		@lynx-js/weak-node-api@0.1.0 @lynx-js/lynx-library-headers@0.0.21

shared/build/library_entry.o: lynxtron/library_entry.cc $(NODE_VENDOR)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-c lynxtron/library_entry.cc -o $@

shared/build/NativePowerSyncModule.o: shared/nativeModule/NativePowerSyncModule.cc $(NODE_VENDOR)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DUSE_WEAK_SUFFIX_NAPI -Ishared/nativeModule \
		-c shared/nativeModule/NativePowerSyncModule.cc -o $@

$(NODE): deps $(NODE_VENDOR) shared/build/ps_sql.o shared/build/NativePowerSyncModule.o shared/build/library_entry.o $(SQLITE_DIR)/sqlite3.o
	mkdir -p dist/macos/arm64
	$(CXX) -std=c++17 -fPIC -O2 -shared -Wl,-undefined,dynamic_lookup \
		shared/build/NativePowerSyncModule.o shared/build/library_entry.o \
		shared/build/ps_sql.o $(SQLITE_DIR)/sqlite3.o \
		$(LDFLAGS) -o $@

node: $(NODE)

WIN_ZIG ?= $(firstword $(wildcard /tmp/zig-macos-aarch64-0.14.0/zig) $(wildcard $(ZIG)))

win-node: deps $(NODE_VENDOR) $(SQLITE_DIR)/sqlite3.c
	@if [ -z "$(WIN_ZIG)" ] || [ ! -x "$(WIN_ZIG)" ]; then \
		echo "zig not found; cannot cross-compile $(WIN_NODE)"; exit 1; \
	fi
	mkdir -p shared/build/win dist/windows/x64
	$(WIN_ZIG) cc -target x86_64-windows-gnu -std=c11 -fPIC -O2 -g0 \
		-I$(SQLITE_DIR) $(SQLITE_FLAGS) \
		-c $(SQLITE_DIR)/sqlite3.c -o shared/build/win/sqlite3.o
	$(WIN_ZIG) c++ -target x86_64-windows-gnu -std=c++17 -fPIC -O2 -g0 \
		-Ishared -I$(SQLITE_DIR) $(SQLITE_FLAGS) \
		-c shared/ps_sql.cc -o shared/build/win/ps_sql.o
	$(WIN_ZIG) c++ -target x86_64-windows-gnu -std=c++17 -fPIC -O2 -g0 \
		-Ishared -I$(SQLITE_DIR) $(SQLITE_FLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-c lynxtron/library_entry.cc -o shared/build/win/library_entry.o
	$(WIN_ZIG) c++ -target x86_64-windows-gnu -std=c++17 -fPIC -O2 -g0 \
		-Ishared -Ishared/nativeModule -I$(SQLITE_DIR) $(SQLITE_FLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DUSE_WEAK_SUFFIX_NAPI \
		-c shared/nativeModule/NativePowerSyncModule.cc -o shared/build/win/NativePowerSyncModule.o
	$(WIN_ZIG) cc -target x86_64-windows-gnu -std=c11 -fPIC -O2 -g0 \
		-c shared/win_host_stubs.c -o shared/build/win/win_host_stubs.o
	$(WIN_ZIG) c++ -target x86_64-windows-gnu -std=c++17 -shared -O2 -g0 \
		-Wl,-s \
		shared/build/win/NativePowerSyncModule.o \
		shared/build/win/library_entry.o \
		shared/build/win/ps_sql.o \
		shared/build/win/sqlite3.o \
		shared/build/win/win_host_stubs.o \
		-Wl,--out-implib,shared/build/win/powersync-lynx.lib \
		-o $(WIN_NODE)
	rm -f dist/windows/x64/*.pdb dist/windows/x64/*.lib dist/windows/x64/*.exp
	node scripts/check-native-artifacts.mjs
