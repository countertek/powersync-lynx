#import "ViewController.h"

#import <Lynx/LynxConfig.h>
#import <Lynx/LynxEnv.h>
#import <Lynx/LynxView.h>

#import "DemoLynxProvider.h"
#import "HostConfig.h"
#import "LynxGeneratedLibraryRegistry.h"

// Declared by powersync-lynx NativePowerSyncModule (Autolinked).
@interface NativePowerSyncModule : NSObject
+ (void)setSharedStreamEventSender:(id)sender;
@end

@implementation ViewController {
  LynxView *_lynxView;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor colorWithRed:0x05 / 255.0
                                              green:0x09 / 255.0
                                               blue:0x10 / 255.0
                                              alpha:1];

  CGSize screen = UIScreen.mainScreen.bounds.size;
  _lynxView = [[LynxView alloc] initWithBuilderBlock:^(LynxViewBuilder *builder) {
    LynxConfig *config = [[LynxConfig alloc] initWithProvider:[[DemoLynxProvider alloc] init]];
    [[[LynxGeneratedLibraryRegistry alloc] init] setup:config];
    [[LynxEnv sharedInstance] prepareConfig:config];
    builder.config = config;
    builder.screenSize = screen;
    builder.fontScale = 1.0;
  }];
  _lynxView.frame = self.view.bounds;
  _lynxView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  _lynxView.preferredLayoutWidth = screen.width;
  _lynxView.preferredLayoutHeight = screen.height;
  _lynxView.layoutWidthMode = LynxViewSizeModeExact;
  _lynxView.layoutHeightMode = LynxViewSizeModeExact;
  [self.view addSubview:_lynxView];

  [_lynxView updateGlobalPropsWithDictionary:[HostConfig globalProps]];
  // Autolink constructs NativePowerSyncModule without a LynxView param. The library
  // does not walk UIWindows; the host must register sendGlobalEvent for incremental
  // /sync/stream (otherwise NativeSyncHttp falls back to idle-complete).
  if ([NativePowerSyncModule respondsToSelector:@selector(setSharedStreamEventSender:)]) {
    [NativePowerSyncModule setSharedStreamEventSender:_lynxView];
  }
  [_lynxView loadTemplateFromURL:@"main.lynx" initData:nil];
}

- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  _lynxView.frame = self.view.bounds;
  _lynxView.preferredLayoutWidth = self.view.bounds.size.width;
  _lynxView.preferredLayoutHeight = self.view.bounds.size.height;
}

@end
