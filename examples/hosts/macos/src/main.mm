#import <Cocoa/Cocoa.h>

#import "AppDelegate.h"

int main(int argc, const char* argv[]) {
  (void)argc;
  (void)argv;
  @autoreleasepool {
    NSApplication* app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    AppDelegate* delegate = [[AppDelegate alloc] init];
    app.delegate = delegate;
    [app run];
    return delegate.exitCode;
  }
}
