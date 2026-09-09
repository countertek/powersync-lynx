#import "HostConfig.h"

@implementation HostConfig

+ (NSString *)valueForArg:(NSString *)argFlag
                      env:(NSString *)envKey
                    plist:(NSString *)plistKey
                 fallback:(NSString *)fallback {
  NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
  NSUInteger idx = [args indexOfObject:argFlag];
  if (idx != NSNotFound && idx + 1 < args.count) {
    NSString *value = args[idx + 1];
    if (value.length > 0 && ![value hasPrefix:@"-"]) {
      return value;
    }
  }
  NSString *env = NSProcessInfo.processInfo.environment[envKey];
  if (env.length > 0) {
    return env;
  }
  id plist = [[NSBundle mainBundle] objectForInfoDictionaryKey:plistKey];
  if ([plist isKindOfClass:[NSString class]] && [(NSString *)plist length] > 0) {
    return (NSString *)plist;
  }
  return fallback;
}

+ (NSString *)device {
  return [self valueForArg:@"-DemoDevice"
                       env:@"DEMO_DEVICE"
                     plist:@"DEMO_DEVICE"
                  fallback:@"ios"];
}

+ (NSString *)demoApiUrl {
  return [self valueForArg:@"-DemoApiUrl"
                       env:@"DEMO_API_URL"
                     plist:@"DEMO_API_URL"
                  fallback:@"http://127.0.0.1:8081"];
}

+ (NSString *)powersyncUrl {
  return [self valueForArg:@"-PowerSyncUrl"
                       env:@"POWERSYNC_URL"
                     plist:@"POWERSYNC_URL"
                  fallback:@"http://127.0.0.1:8080"];
}

+ (NSDictionary<NSString *, NSString *> *)globalProps {
  return @{
    @"device" : [self device],
    @"demoApiUrl" : [self demoApiUrl],
    @"powersyncUrl" : [self powersyncUrl],
  };
}

@end
