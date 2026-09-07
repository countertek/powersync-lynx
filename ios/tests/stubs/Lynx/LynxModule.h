#ifndef POWERSYNC_LYNX_TEST_STUB_LYNX_MODULE_H_
#define POWERSYNC_LYNX_TEST_STUB_LYNX_MODULE_H_

#import <Foundation/Foundation.h>

@protocol LynxModule <NSObject>
@optional
+ (NSString*)name;
+ (NSDictionary<NSString*, NSString*>*)methodLookup;
@end

#ifndef LynxNativeModule
#define LynxNativeModule(name)
#endif

#endif
