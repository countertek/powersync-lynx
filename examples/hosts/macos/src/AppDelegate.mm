#import "AppDelegate.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "NativePowerSyncModule.h"
#include "capi/lynx_log_capi.h"
#include "lynx_env.h"
#include "lynx_load_meta.h"
#include "lynx_service_center.h"
#include "lynx_template_data.h"
#include "lynx_view.h"
#include "lynx_view_client.h"

#import "HostConfig.h"
#import "ShowcaseHttpService.h"
#import "ShowcaseResourceFetcher.h"

namespace {

const char* LogLevelName(lynx_log_level_e level) {
  switch (level) {
    case LYNX_LOG_VERBOSE:
      return "V";
    case LYNX_LOG_DEBUG:
      return "D";
    case LYNX_LOG_INFO:
      return "I";
    case LYNX_LOG_WARNING:
      return "W";
    case LYNX_LOG_ERROR:
      return "E";
    case LYNX_LOG_FATAL:
      return "F";
  }
  return "?";
}

void OnLynxLog(lynx_log_level_e level, const char* tag, const char* msg) {
  if (level < LYNX_LOG_INFO) {
    return;
  }
  std::fprintf(stderr, "[Lynx/%s][%s] %s\n", LogLevelName(level),
               tag ? tag : "lynx", msg ? msg : "");
  std::fflush(stderr);
}

class ShowcaseViewClient final : public lynx::pub::LynxViewClient {
 public:
  std::atomic<bool> load_succeeded{false};
  std::atomic<bool> first_screen{false};
  std::atomic<bool> runtime_ready{false};
  std::atomic<bool> had_error{false};

  void OnPageStart(const char* url) override {
    std::fprintf(stderr, "[LynxView] OnPageStart: %s\n", url ? url : "");
    std::fflush(stderr);
  }
  void OnLoadSuccess() override {
    load_succeeded.store(true);
    std::fprintf(stderr, "[LynxView] OnLoadSuccess\n");
    std::fflush(stderr);
  }
  void OnFirstScreen() override {
    first_screen.store(true);
    std::fprintf(stderr, "[LynxView] OnFirstScreen\n");
    std::fflush(stderr);
  }
  void OnRuntimeReady() override {
    runtime_ready.store(true);
    std::fprintf(stderr, "[LynxView] OnRuntimeReady\n");
    std::fflush(stderr);
  }
  void OnReceivedError(int error_code, const char* message) override {
    // Lynx CSS property warnings (e.g. 130300 "CSS length need units") are non-fatal.
    if (error_code < 130000 || error_code >= 140000) {
      had_error.store(true);
    }
    std::fprintf(stderr, "[LynxView] OnReceivedError(%d): %s\n", error_code,
                 message ? message : "");
    std::fflush(stderr);
  }
  void OnDestroy() override {
    std::fprintf(stderr, "[LynxView] OnDestroy\n");
    std::fflush(stderr);
  }
};

std::string ResolveIcuDataPath() {
  NSString* resDir = NSBundle.mainBundle.resourcePath;
  if (resDir.length > 0) {
    NSString* candidate = [resDir stringByAppendingPathComponent:@"data/icudtl.dat"];
    if ([NSFileManager.defaultManager fileExistsAtPath:candidate]) {
      return std::string(candidate.UTF8String);
    }
    NSString* flat = [resDir stringByAppendingPathComponent:@"icudtl.dat"];
    if ([NSFileManager.defaultManager fileExistsAtPath:flat]) {
      return std::string(flat.UTF8String);
    }
  }
  return "";
}

bool ReadFileBytes(const std::string& path, std::vector<uint8_t>* out) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file) {
    return false;
  }
  std::streamsize size = file.tellg();
  if (size <= 0) {
    return false;
  }
  file.seekg(0, std::ios::beg);
  out->resize(static_cast<size_t>(size));
  return static_cast<bool>(
      file.read(reinterpret_cast<char*>(out->data()), size));
}

}  // namespace

static void StopAppLoop(void) {
  [NSApp stop:nil];
  NSEvent* wakeup = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                       location:NSZeroPoint
                                  modifierFlags:0
                                      timestamp:0
                                   windowNumber:0
                                        context:nil
                                        subtype:0
                                          data1:0
                                          data2:0];
  [NSApp postEvent:wakeup atStart:YES];
}

@implementation AppDelegate {
  NSWindow* _window;
  NSView* _contentView;
  HostConfig _config;
  std::unique_ptr<lynx::pub::LynxView> _lynxView;
  std::shared_ptr<ShowcaseViewClient> _viewClient;
  std::shared_ptr<ShowcaseHttpService> _httpService;
  std::shared_ptr<ShowcaseResourceFetcher> _resourceFetcher;
  int _exitCode;
}

@synthesize exitCode = _exitCode;

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;
  _exitCode = 0;
  _config = HostConfig::FromProcess();

  lynx_log_init(OnLynxLog);
  lynx_log_set_minimum_level(LYNX_LOG_INFO);

  auto& env = lynx::pub::LynxEnv::GetInstance();
  std::string icuPath = ResolveIcuDataPath();
  if (!icuPath.empty()) {
    env.SetICUDataPath(icuPath.c_str());
  }

  // Register NativePowerSyncModule from powersync_lynx_native.
  env.RegisterNativeModule("NativePowerSyncModule", CreateNativePowerSyncModule,
                           nullptr);

  // Register NSURLSession-backed LynxHttpService.
  _httpService = std::make_shared<ShowcaseHttpService>();
  lynx::pub::LynxServiceCenter::GetInstance().RegisterService(_httpService);

  std::fprintf(stderr,
               "[PowerSyncLynxShowcase] Lynx SDK %s | bundleId=%s | device=%s | "
               "demoApi=%s | powersync=%s | bundle=%s\n",
               env.GetVersion() ? env.GetVersion() : "unknown",
               NSBundle.mainBundle.bundleIdentifier
                   ? NSBundle.mainBundle.bundleIdentifier.UTF8String
                   : "(none)",
               _config.device.c_str(), _config.demo_api_url.c_str(),
               _config.powersync_url.c_str(), _config.bundle_path.c_str());
  std::fflush(stderr);

  constexpr CGFloat kInitialWidth = 520.0;
  constexpr CGFloat kInitialHeight = 820.0;
  NSRect frame = NSMakeRect(0, 0, kInitialWidth, kInitialHeight);
  NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable;
  _window = [[NSWindow alloc] initWithContentRect:frame
                                        styleMask:style
                                          backing:NSBackingStoreBuffered
                                            defer:NO];
  _window.title =
      [NSString stringWithFormat:@"PowerSync Lynx Showcase (%s)",
                                 _config.device.c_str()];
  _window.delegate = self;
  _window.backgroundColor = [NSColor colorWithSRGBRed:0x05 / 255.0
                                                green:0x09 / 255.0
                                                 blue:0x10 / 255.0
                                                alpha:1.0];

  _contentView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, kInitialWidth, kInitialHeight)];
  _contentView.wantsLayer = YES;
  _contentView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  _window.contentView = _contentView;
  [_window center];
  [_window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];

  CGFloat scale = _window.backingScaleFactor > 0.0 ? _window.backingScaleFactor : 2.0;
  _resourceFetcher = std::make_shared<ShowcaseResourceFetcher>();

  lynx::pub::LynxView::Builder builder;
  builder.SetScreenSize(static_cast<float>(kInitialWidth),
                        static_cast<float>(kInitialHeight),
                        static_cast<float>(scale))
      .SetFrame(0.0f, 0.0f, static_cast<float>(kInitialWidth),
                static_cast<float>(kInitialHeight))
      .SetFontScale(1.0f)
      .SetParent((__bridge NativeWindow)_contentView)
      .SetGenericResourceFetcher(_resourceFetcher);
  if (!icuPath.empty()) {
    builder.SetICUDataPath(icuPath);
  }

  _lynxView = builder.Build();
  _viewClient = std::make_shared<ShowcaseViewClient>();
  _lynxView->AddClient(_viewClient);

  std::vector<uint8_t> bundleBytes;
  if (!ReadFileBytes(_config.bundle_path, &bundleBytes)) {
    std::fprintf(stderr,
                 "[PowerSyncLynxShowcase] Failed to read Lynx bundle at: %s\n"
                 "Build it first with: pnpm --dir examples/showcase build\n",
                 _config.bundle_path.c_str());
    std::fflush(stderr);
    _exitCode = 1;
    if (_config.smoke_test) {
      StopAppLoop();
    }
    return;
  }

  auto* ownedBytes = new uint8_t[bundleBytes.size()];
  std::memcpy(ownedBytes, bundleBytes.data(), bundleBytes.size());

  auto loadMeta = std::make_shared<lynx::pub::LynxLoadMeta>();
  loadMeta->SetUrl("main.lynx.bundle");
  loadMeta->SetBinaryData(
      ownedBytes, bundleBytes.size(),
      [](uint8_t* ptr, size_t, void*) { delete[] ptr; }, nullptr);
  loadMeta->SetGlobalProps(
      std::make_shared<lynx::pub::LynxTemplateData>(_config.GlobalPropsJson()));
  _lynxView->LoadTemplate(loadMeta);

  if (_config.smoke_test) {
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW,
                      static_cast<int64_t>(_config.smoke_seconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          bool ok = _viewClient->load_succeeded.load() &&
                    _viewClient->runtime_ready.load() &&
                    !_viewClient->had_error.load();
          std::fprintf(stderr,
                       "[PowerSyncLynxShowcase] smoke-test complete: "
                       "loadSuccess=%d firstScreen=%d runtimeReady=%d error=%d\n",
                       _viewClient->load_succeeded.load() ? 1 : 0,
                       _viewClient->first_screen.load() ? 1 : 0,
                       _viewClient->runtime_ready.load() ? 1 : 0,
                       _viewClient->had_error.load() ? 1 : 0);
          std::fflush(stderr);
          _exitCode = ok ? 0 : 1;
          StopAppLoop();
        });
  }
}

- (void)windowDidResize:(NSNotification*)notification {
  (void)notification;
  if (!_lynxView || _contentView == nil) {
    return;
  }
  NSRect bounds = _contentView.bounds;
  CGFloat scale = _window.backingScaleFactor > 0.0 ? _window.backingScaleFactor : 2.0;
  _lynxView->UpdateScreenMetrics(static_cast<float>(bounds.size.width),
                                 static_cast<float>(bounds.size.height),
                                 static_cast<float>(scale));
  _lynxView->SetFrame(0.0f, 0.0f, static_cast<float>(bounds.size.width),
                      static_cast<float>(bounds.size.height));
}

- (void)applicationWillTerminate:(NSNotification*)notification {
  (void)notification;
  if (_lynxView && _viewClient) {
    _lynxView->RemoveClient(_viewClient);
  }
  _lynxView.reset();
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
  (void)sender;
  return YES;
}

@end
