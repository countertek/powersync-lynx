#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HostConfig : NSObject
+ (NSDictionary<NSString *, NSString *> *)globalProps;
+ (NSString *)device;
+ (NSString *)demoApiUrl;
+ (NSString *)powersyncUrl;
@end

NS_ASSUME_NONNULL_END
