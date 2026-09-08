#import <Foundation/Foundation.h>
#import <Lynx/LynxModule.h>

#ifndef LynxNativeModule
#define LynxNativeModule(name)
#endif

NS_ASSUME_NONNULL_BEGIN

@LynxNativeModule("NativePowerSyncModule")
@interface NativePowerSyncModule : NSObject <LynxModule>
@end

NS_ASSUME_NONNULL_END
