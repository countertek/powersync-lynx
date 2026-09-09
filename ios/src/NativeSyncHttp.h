#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Native Module HTTP for /sync/stream. Autolink methods stay on
/// NativePowerSyncModule; this is the SQL/HTTP boundary.
@interface NativeSyncHttp : NSObject

+ (void)setSharedStreamEventSender:(nullable id)sender;

- (instancetype)initWithEventSender:(nullable id)sender;

- (void)fetch:(NSDictionary *)request callback:(void (^)(id))callback;
- (void)abort:(NSString *)streamId callback:(void (^)(id))callback;

@end

NS_ASSUME_NONNULL_END
