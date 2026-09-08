#import "AppDelegate.h"
#import "ViewController.h"

#import <Lynx/LynxEnv.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  // LynxHttpService registers via @LynxServiceRegister; -ObjC keeps the class.
  (void)NSClassFromString(@"LynxHttpService");
  LynxEnv *env = [LynxEnv sharedInstance];
  [env setLocalEnv:@"true" forKey:@"enable_fetch_api_standard_streaming"];

  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [[ViewController alloc] init];
  [self.window makeKeyAndVisible];
  return YES;
}

@end
