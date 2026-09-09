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
IOS_TEST_BIN := shared/build/ios_module_rpc_test
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

test: deps $(TEST_BIN)
	POWERSYNC_CORE_PATH="$(CURDIR)/$(CORE_DYLIB)" $(TEST_BIN)

$(IOS_TEST_BIN): deps ios/tests/ios_module_rpc_test.mm ios/src/NativePowerSyncModule.mm \
		ios/src/NativePowerSyncModule.h ios/src/IdleCompleteHttp.mm ios/src/IdleCompleteHttp.h \
		shared/ps_sql.cc shared/ps_sql.h \
		$(SQLITE_DIR)/sqlite3.o $(CORE_DYLIB)
	mkdir -p shared/build/ios-src
	sed 's/@LynxNativeModule("[^"]*")//' ios/src/NativePowerSyncModule.h \
		> shared/build/ios-src/NativePowerSyncModule.h
	cp ios/src/NativePowerSyncModule.mm shared/build/ios-src/NativePowerSyncModule.mm
	cp ios/src/IdleCompleteHttp.h ios/src/IdleCompleteHttp.mm shared/build/ios-src/
	clang++ -std=c++17 -fPIC -O2 -fobjc-arc -fblocks \
		-Ishared/build/ios-src -Iios/tests/stubs -Ishared -I$(SQLITE_DIR) \
		$(SQLITE_FLAGS) -DPS_SQL_LINK_CORE=1 \
		ios/tests/ios_module_rpc_test.mm shared/build/ios-src/NativePowerSyncModule.mm \
		shared/build/ios-src/IdleCompleteHttp.mm \
		shared/ps_sql.cc $(SQLITE_DIR)/sqlite3.o \
		$(CORE_DYLIB) -framework Foundation $(LDFLAGS) \
		-Wl,-rpath,$(CURDIR)/dist/macos/arm64 \
		-o $@
	install_name_tool -change \
		/Users/runner/work/powersync-sqlite-core/powersync-sqlite-core/target/aarch64-apple-darwin/release/deps/libpowersync.dylib \
		$(CURDIR)/$(CORE_DYLIB) $@

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
