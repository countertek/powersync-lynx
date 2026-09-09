#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Native Module HTTP for /sync/stream. Autolink methods stay on
/// NativePowerSyncModule; this is the SQL/HTTP boundary.
///
/// Session decisions live in {@code shared/sync_http_session.h} (N3). Incremental
/// GlobalEventEmitter events require a host-provided sender that implements
/// {@code sendGlobalEvent:withParams:} ({@code LynxView} in the showcase).
/// Inject via {@code initWithEventSender:} / Autolink {@code initWithParam:} or
/// {@code +setSharedStreamEventSender:}. If none is registered, {@code fetch:}
/// uses the idle-complete fallback (same envelope as C).
@interface NativeSyncHttp : NSObject

+ (void)setSharedStreamEventSender:(nullable id)sender;

- (instancetype)initWithEventSender:(nullable id)sender;

- (void)fetch:(NSDictionary *)request callback:(void (^)(id))callback;
- (void)abort:(NSString *)streamId callback:(void (^)(id))callback;

@end

NS_ASSUME_NONNULL_END
