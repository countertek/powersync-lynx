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
  FETCH_DEPS_FLAGS := --linux-x64
  JNI_OS_INCLUDE := linux
  JAVA_HOME ?= $(shell dirname $$(dirname $$(readlink -f $$(command -v java))))
else ifeq ($(UNAME_S),Darwin)
  JNI_OS_INCLUDE := darwin
  JAVA_HOME ?= $(shell /usr/libexec/java_home 2>/dev/null)
  MACOS_LDFLAGS := -framework CoreFoundation -framework Foundation
  NODE_SHARED_LDFLAGS := -Wl,-undefined,dynamic_lookup
  SYNC_HTTP_OBJS := shared/build/sync_http_session.o shared/build/sync_http_engine.o shared/build/apple_sync_http.o
  ifeq ($(UNAME_M),arm64)
    CORE_DYLIB := dist/macos/arm64/libpowersync_aarch64.macos.dylib
    FETCH_DEPS_FLAGS := --macos-arm64
  else
    CORE_DYLIB := dist/macos/x64/libpowersync_x64.macos.dylib
    FETCH_DEPS_FLAGS :=
  endif
else
  CORE_DYLIB := dist/macos/arm64/libpowersync_aarch64.macos.dylib
  FETCH_DEPS_FLAGS := --macos-arm64
  JNI_OS_INCLUDE := darwin
  JAVA_HOME ?= $(shell /usr/libexec/java_home 2>/dev/null)
  MACOS_LDFLAGS := -framework CoreFoundation -framework Foundation
  NODE_SHARED_LDFLAGS := -Wl,-undefined,dynamic_lookup
  SYNC_HTTP_OBJS := shared/build/sync_http_session.o shared/build/sync_http_engine.o shared/build/apple_sync_http.o
endif
ifeq ($(UNAME_S),Linux)
  SYNC_HTTP_OBJS := shared/build/sync_http_session.o shared/build/sync_http_engine.o
endif
TEST_BIN := shared/build/ps_sql_test
FIXTURE_TEST_BIN := shared/build/sync_stream_fixtures_test
SESSION_TEST_BIN := shared/build/sync_http_session_test
ENGINE_TEST_BIN := shared/build/sync_http_engine_test
DESKTOP_NAPI_TEST_ADDON := shared/build/desktop_napi_test.node
IOS_TEST_BIN := shared/build/ios_module_rpc_test
ANDROID_JAVA_DIR := $(CURDIR)/android/src/main/java/com/powersync/lynx
FIXTURES_JSON := $(CURDIR)/shared/fixtures/sync-stream.json
NODE := dist/macos/arm64/powersync-lynx.node
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

JNI_CFLAGS := -I$(JAVA_HOME)/include -I$(JAVA_HOME)/include/$(JNI_OS_INCLUDE)
JNI_OBJ := shared/build/ps_sql_jni.o
JNI_SESSION_OBJ := shared/build/sync_http_session_jni.o
POD_ENGINE_OBJ := shared/build/ps_sql_engine_pod.o
POD_SYNC_HTTP_SESSION_OBJ := shared/build/sync_http_session_pod.o
POD_SYNC_HTTP_ENGINE_OBJ := shared/build/sync_http_engine_pod.o

ANDROID_SDK ?= $(ANDROID_HOME)
ADB := $(ANDROID_SDK)/platform-tools/adb
EMULATOR := $(ANDROID_SDK)/emulator/emulator
ANDROID_AVD ?= Pixel_10_Pro

.PHONY: deps test test-ios test-android node all

all: test node

deps:
	node scripts/fetch-native-deps.mjs $(FETCH_DEPS_FLAGS)

$(SQLITE_DIR)/sqlite3.c:
	node scripts/fetch-native-deps.mjs $(FETCH_DEPS_FLAGS)

$(SQLITE_DIR)/sqlite3.o: $(SQLITE_DIR)/sqlite3.c
	$(CC) $(CFLAGS) -c $< -o $@

shared/build/ps_sql.o: shared/ps_sql.cc shared/ps_sql.h shared/win_utf8.h $(SQLITE_DIR)/sqlite3.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) -c shared/ps_sql.cc -o $@

$(TEST_BIN): shared/build/ps_sql.o $(SQLITE_DIR)/sqlite3.o shared/tests/ps_sql_test.cc shared/nativeModule/core_path.h shared/nativeModule/db_location.h shared/win_utf8.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) shared/tests/ps_sql_test.cc \
		shared/build/ps_sql.o $(SQLITE_DIR)/sqlite3.o $(LDFLAGS) $(MACOS_LDFLAGS) -o $@

$(FIXTURE_TEST_BIN): shared/tests/sync_stream_fixtures_test.cc \
		shared/sync_stream_fixtures.h shared/tests/ndjson_http_replay.h \
		shared/sync_http_policy.h shared/fixtures/sync-stream.json
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/tests \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		shared/tests/sync_stream_fixtures_test.cc $(LDFLAGS) -o $@

shared/build/sync_http_session.o: shared/sync_http/sync_http_session.cc \
		shared/sync_http/sync_http_session.h shared/sync_http_policy.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http -c shared/sync_http/sync_http_session.cc -o $@

shared/build/sync_http_engine.o: shared/sync_http/sync_http_engine.cc \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_session.h \
		shared/sync_http_policy.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http -c shared/sync_http/sync_http_engine.cc -o $@

shared/build/apple_sync_http.o: shared/sync_http/apple_sync_http.mm \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_session.h \
		shared/sync_http_policy.h
	mkdir -p shared/build
	clang++ -std=c++17 -fPIC -O2 -fobjc-arc -fblocks -Ishared -Ishared/sync_http \
		-c shared/sync_http/apple_sync_http.mm -o $@

$(SESSION_TEST_BIN): shared/tests/sync_http_session_test.cc \
		shared/sync_http/sync_http_session.h shared/sync_http_policy.h \
		shared/sync_stream_fixtures.h shared/fixtures/sync-stream.json \
		shared/build/sync_http_session.o
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		shared/tests/sync_http_session_test.cc shared/build/sync_http_session.o \
		$(LDFLAGS) -o $@

$(ENGINE_TEST_BIN): shared/tests/sync_http_engine_test.cc \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_session.h \
		shared/sync_stream_fixtures.h shared/tests/ndjson_http_replay.h \
		shared/fixtures/sync-stream.json $(SYNC_HTTP_OBJS)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http -Ishared/tests \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		shared/tests/sync_http_engine_test.cc $(SYNC_HTTP_OBJS) \
		$(LDFLAGS) $(MACOS_LDFLAGS) -o $@

test: deps $(TEST_BIN) $(FIXTURE_TEST_BIN) $(SESSION_TEST_BIN) $(ENGINE_TEST_BIN) \
		$(DESKTOP_NAPI_TEST_ADDON) \
		$(JNI_OBJ) $(JNI_SESSION_OBJ) $(POD_ENGINE_OBJ) $(POD_SYNC_HTTP_SESSION_OBJ) $(POD_SYNC_HTTP_ENGINE_OBJ)
	@! grep -n 'UIApplication.sharedApplication.windows' ios/src/NativeSyncHttp.mm
	@! grep -n 'findLynxViewIn' ios/src/NativeSyncHttp.mm
	POWERSYNC_CORE_PATH="$(CURDIR)/$(CORE_DYLIB)" $(TEST_BIN)
	PS_SYNC_STREAM_FIXTURES_PATH="$(FIXTURES_JSON)" $(FIXTURE_TEST_BIN)
	PS_SYNC_STREAM_FIXTURES_PATH="$(FIXTURES_JSON)" $(SESSION_TEST_BIN)
	PS_SYNC_STREAM_FIXTURES_PATH="$(FIXTURES_JSON)" $(ENGINE_TEST_BIN)
	POWERSYNC_CORE_PATH="$(CURDIR)/$(CORE_DYLIB)" \
		PS_DESKTOP_NAPI_ADDON="$(CURDIR)/$(DESKTOP_NAPI_TEST_ADDON)" \
		PS_SYNC_STREAM_FIXTURES_PATH="$(FIXTURES_JSON)" \
		node shared/tests/desktop_napi_test.mjs
	node scripts/gen-sync-http-policy-java.mjs --check

$(JNI_OBJ): android/src/main/cpp/ps_sql_jni.cc shared/ps_sql.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) $(JNI_CFLAGS) -c android/src/main/cpp/ps_sql_jni.cc -o $@

$(JNI_SESSION_OBJ): android/src/main/cpp/sync_http_session_jni.cc \
		shared/sync_http/sync_http_session.h shared/sync_http_policy.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http $(JNI_CFLAGS) -c android/src/main/cpp/sync_http_session_jni.cc -o $@

$(POD_ENGINE_OBJ): ios/src/ps_sql_engine.cc shared/ps_sql.cc shared/ps_sql.h $(SQLITE_DIR)/sqlite3.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) -c ios/src/ps_sql_engine.cc -o $@

$(POD_SYNC_HTTP_SESSION_OBJ): ios/src/sync_http_session_pod.cc shared/sync_http/sync_http_session.cc \
		shared/sync_http/sync_http_session.h shared/sync_http_policy.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http -c ios/src/sync_http_session_pod.cc -o $@

$(POD_SYNC_HTTP_ENGINE_OBJ): ios/src/sync_http_engine_pod.cc shared/sync_http/sync_http_engine.cc \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_session.h shared/sync_http_policy.h
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) -Ishared/sync_http -c ios/src/sync_http_engine_pod.cc -o $@

$(IOS_TEST_BIN): deps ios/tests/ios_module_rpc_test.mm ios/tests/ios_sync_http_fixture_test.mm \
		ios/tests/ios_sync_http_fixtures.h \
		ios/src/NativePowerSyncModule.mm \
		ios/src/NativePowerSyncModule.h ios/src/NativeSyncHttp.mm ios/src/NativeSyncHttp.h \
		ios/src/sync_http_session_pod.cc ios/src/sync_http_engine_pod.cc ios/src/apple_sync_http_pod.mm \
		shared/sync_http_policy.h shared/sync_http/sync_http_session.h shared/sync_http/sync_http_session.cc \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_engine.cc shared/sync_http/apple_sync_http.mm \
		shared/sync_stream_fixtures.h \
		shared/tests/ndjson_http_replay.h shared/fixtures/sync-stream.json \
		shared/ps_sql.cc shared/ps_sql.h \
		$(SQLITE_DIR)/sqlite3.o $(CORE_DYLIB)
	mkdir -p shared/build/ios-src
	sed 's/@LynxNativeModule("[^"]*")//' ios/src/NativePowerSyncModule.h \
		> shared/build/ios-src/NativePowerSyncModule.h
	cp ios/src/NativePowerSyncModule.mm shared/build/ios-src/NativePowerSyncModule.mm
	cp ios/src/NativeSyncHttp.h ios/src/NativeSyncHttp.mm shared/build/ios-src/
	cp ios/src/sync_http_session_pod.cc ios/src/sync_http_engine_pod.cc ios/src/apple_sync_http_pod.mm shared/build/ios-src/
	clang++ -std=c++17 -fPIC -O2 -fobjc-arc -fblocks \
		-Ishared/build/ios-src -Iios/tests -Iios/tests/stubs -Ishared -Ishared/sync_http -Ishared/tests -I$(SQLITE_DIR) \
		$(SQLITE_FLAGS) -DPS_SQL_LINK_CORE=1 \
		-DPS_SYNC_STREAM_FIXTURES_PATH='"$(FIXTURES_JSON)"' \
		ios/tests/ios_module_rpc_test.mm ios/tests/ios_sync_http_fixture_test.mm \
		shared/build/ios-src/NativePowerSyncModule.mm \
		shared/build/ios-src/NativeSyncHttp.mm \
		shared/build/ios-src/sync_http_session_pod.cc \
		shared/build/ios-src/sync_http_engine_pod.cc \
		shared/build/ios-src/apple_sync_http_pod.mm \
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
NODE_VENDOR_MARKER := $(NODE_VENDOR)/@lynx-js/lynx-library-headers/include/lynx/registration.h
NAPI_INCLUDE := -I$(NODE_VENDOR)/@lynx-js/weak-node-api/headers \
	-I$(NODE_VENDOR)/@lynx-js/lynx-library-headers/include \
	-I$(NODE_VENDOR)/@lynx-js/lynx-library-headers/include/third_party/weak-node-api/headers

$(NODE_VENDOR_MARKER):
	mkdir -p native-vendor
	printf '{"name":"powersync-lynx-native-vendor","private":true}\n' > native-vendor/package.json
	printf 'packages: []\n' > native-vendor/pnpm-workspace.yaml
	cd native-vendor && $(PNPM) add --no-lockfile --ignore-scripts \
		@lynx-js/weak-node-api@0.1.0 @lynx-js/lynx-library-headers@0.0.31

shared/build/library_entry.o: lynxtron/library_entry.cc $(NODE_VENDOR_MARKER)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-c lynxtron/library_entry.cc -o $@

shared/build/NativePowerSyncModule.o: shared/nativeModule/NativePowerSyncModule.cc \
		shared/nativeModule/NativePowerSyncModule.h shared/nativeModule/NativePowerSyncBindings.h \
		shared/nativeModule/core_path.h shared/nativeModule/db_location.h \
		shared/ps_sql.h shared/sync_http/sync_http_engine.h \
		shared/win_utf8.h $(NODE_VENDOR_MARKER)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DUSE_WEAK_SUFFIX_NAPI -Ishared/nativeModule -Ishared/sync_http \
		-c shared/nativeModule/NativePowerSyncModule.cc -o $@

shared/build/NativeSyncHttpNapi.o: shared/nativeModule/NativeSyncHttpNapi.cc \
		shared/nativeModule/NativePowerSyncModule.h shared/nativeModule/NativePowerSyncBindings.h \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_session.h \
		shared/sync_http_policy.h $(NODE_VENDOR_MARKER)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DUSE_WEAK_SUFFIX_NAPI -Ishared/nativeModule -Ishared/sync_http \
		-c shared/nativeModule/NativeSyncHttpNapi.cc -o $@

# Stock Node.js N-API test objects (no USE_WEAK_SUFFIX_NAPI, no Lynx static registration).
shared/build/NativePowerSyncModule_test.o: shared/nativeModule/NativePowerSyncModule.cc \
		shared/nativeModule/NativePowerSyncModule.h shared/nativeModule/NativePowerSyncBindings.h \
		shared/nativeModule/core_path.h shared/nativeModule/db_location.h \
		shared/ps_sql.h shared/sync_http/sync_http_engine.h \
		shared/win_utf8.h $(NODE_VENDOR_MARKER)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(SQLITE_FLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DPOWERSYNC_NO_STATIC_REGISTRATION -Ishared/nativeModule -Ishared/sync_http \
		-c shared/nativeModule/NativePowerSyncModule.cc -o $@

shared/build/NativeSyncHttpNapi_test.o: shared/nativeModule/NativeSyncHttpNapi.cc \
		shared/nativeModule/NativePowerSyncModule.h shared/nativeModule/NativePowerSyncBindings.h \
		shared/sync_http/sync_http_engine.h shared/sync_http/sync_http_session.h \
		shared/sync_http_policy.h $(NODE_VENDOR_MARKER)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DPOWERSYNC_NO_STATIC_REGISTRATION -Ishared/nativeModule -Ishared/sync_http \
		-c shared/nativeModule/NativeSyncHttpNapi.cc -o $@

shared/build/desktop_napi_test_addon.o: shared/tests/desktop_napi_test_addon.cc \
		shared/nativeModule/NativePowerSyncBindings.h shared/ps_sql.h \
		shared/sync_http/sync_http_engine.h $(NODE_VENDOR_MARKER)
	mkdir -p shared/build
	$(CXX) $(CXXFLAGS) $(NAPI_INCLUDE) -DNAPI_VERSION=8 \
		-DPOWERSYNC_NO_STATIC_REGISTRATION -Ishared/nativeModule -Ishared/sync_http \
		-c shared/tests/desktop_napi_test_addon.cc -o $@

$(DESKTOP_NAPI_TEST_ADDON): deps $(NODE_VENDOR_MARKER) shared/build/ps_sql.o \
		shared/build/NativePowerSyncModule_test.o shared/build/NativeSyncHttpNapi_test.o \
		shared/build/desktop_napi_test_addon.o $(SYNC_HTTP_OBJS) $(SQLITE_DIR)/sqlite3.o
	mkdir -p shared/build
	$(CXX) -std=c++17 -fPIC -O2 -shared $(NODE_SHARED_LDFLAGS) \
		shared/build/desktop_napi_test_addon.o \
		shared/build/NativePowerSyncModule_test.o shared/build/NativeSyncHttpNapi_test.o \
		$(SYNC_HTTP_OBJS) shared/build/ps_sql.o $(SQLITE_DIR)/sqlite3.o \
		$(LDFLAGS) $(MACOS_LDFLAGS) -o $@

$(NODE): deps $(NODE_VENDOR_MARKER) shared/build/ps_sql.o \
		shared/build/NativePowerSyncModule.o shared/build/NativeSyncHttpNapi.o \
		$(SYNC_HTTP_OBJS) shared/build/library_entry.o $(SQLITE_DIR)/sqlite3.o
	mkdir -p dist/macos/arm64
	$(CXX) -std=c++17 -fPIC -O2 -shared -Wl,-undefined,dynamic_lookup \
		shared/build/NativePowerSyncModule.o shared/build/NativeSyncHttpNapi.o \
		$(SYNC_HTTP_OBJS) shared/build/library_entry.o shared/build/ps_sql.o \
		$(SQLITE_DIR)/sqlite3.o $(LDFLAGS) $(MACOS_LDFLAGS) -o $@

node: $(NODE)
