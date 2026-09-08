#import "AppDelegate.h"

#import <Lynx/LynxEnv.h>
#import <Lynx/LynxView.h>
#import <LynxService/LynxHttpService.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  // HTTP Service is required for Connector fetch and /sync/stream.
  // Autolink does not replace this.
  [LynxServiceCenter.sharedInstance registerService:LynxHttpService.sharedInstance];

  // Autolink's generated registry is loaded when LynxEnv initializes.
  [LynxEnv.sharedInstance initialize];
  return YES;
}

@end
