#import "HostConfig.h"

#import <Foundation/Foundation.h>

#include <cstdlib>
#include <sstream>

namespace {

std::string EscapeJson(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 8);
  for (unsigned char c : input) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  return out;
}

std::string ReadOption(NSArray<NSString*>* args,
                       NSDictionary<NSString*, NSString*>* env,
                       NSArray<NSString*>* argFlags,
                       NSString* envKey,
                       const std::string& fallback) {
  for (NSString* flag in argFlags) {
    NSUInteger idx = [args indexOfObject:flag];
    if (idx != NSNotFound && idx + 1 < args.count) {
      NSString* val = args[idx + 1];
      if (val.length > 0) {
        return std::string(val.UTF8String);
      }
    }
  }
  NSString* envVal = env[envKey];
  if (envVal.length > 0) {
    return std::string(envVal.UTF8String);
  }
  return fallback;
}

bool HasFlag(NSArray<NSString*>* args,
             NSDictionary<NSString*, NSString*>* env,
             NSString* argFlag,
             NSString* envKey) {
  if ([args containsObject:argFlag]) {
    return true;
  }
  NSString* envVal = env[envKey];
  return envVal != nil && ([envVal isEqualToString:@"1"] ||
                           [envVal.lowercaseString isEqualToString:@"true"]);
}

std::string ResolveDefaultBundlePath() {
  NSBundle* mainBundle = [NSBundle mainBundle];
  NSString* bundled = [mainBundle pathForResource:@"main.lynx" ofType:@"bundle"];
  if (bundled.length > 0 && [[NSFileManager defaultManager] fileExistsAtPath:bundled]) {
    return std::string(bundled.UTF8String);
  }
#ifdef POWERSYNC_DEFAULT_BUNDLE_PATH
  NSString* buildPath = @POWERSYNC_DEFAULT_BUNDLE_PATH;
  if ([[NSFileManager defaultManager] fileExistsAtPath:buildPath]) {
    return std::string(buildPath.UTF8String);
  }
#endif
  return "main.lynx.bundle";
}

}  // namespace

HostConfig HostConfig::FromProcess() {
  NSArray<NSString*>* args = NSProcessInfo.processInfo.arguments;
  NSDictionary<NSString*, NSString*>* env = NSProcessInfo.processInfo.environment;

  HostConfig config;
  config.device = ReadOption(
      args, env, @[ @"-DemoDevice", @"--device" ], @"DEMO_DEVICE", "macos");
  config.demo_api_url = ReadOption(
      args, env, @[ @"-DemoApiUrl", @"--demo-api-url" ], @"DEMO_API_URL",
      "http://127.0.0.1:8081");
  config.powersync_url = ReadOption(
      args, env, @[ @"-PowerSyncUrl", @"--powersync-url" ], @"POWERSYNC_URL",
      "http://127.0.0.1:8080");
  config.bundle_path = ReadOption(
      args, env, @[ @"-BundlePath", @"--bundle" ], @"LYNX_BUNDLE_PATH",
      ResolveDefaultBundlePath());
  config.smoke_test = HasFlag(args, env, @"--smoke-test", @"SMOKE_TEST");

  std::string secondsStr = ReadOption(
      args, env, @[ @"--smoke-seconds" ], @"SMOKE_TEST_SECONDS", "");
  if (!secondsStr.empty()) {
    double parsed = std::strtod(secondsStr.c_str(), nullptr);
    if (parsed > 0.0) {
      config.smoke_seconds = parsed;
    }
  }
  return config;
}

std::string HostConfig::GlobalPropsJson() const {
  std::ostringstream oss;
  oss << "{\"device\":\"" << EscapeJson(device)
      << "\",\"demoApiUrl\":\"" << EscapeJson(demo_api_url)
      << "\",\"powersyncUrl\":\"" << EscapeJson(powersync_url) << "\"}";
  return oss.str();
}
