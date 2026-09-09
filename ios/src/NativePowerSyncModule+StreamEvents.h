#import "NativePowerSyncModule.h"

NS_ASSUME_NONNULL_BEGIN

@interface NativePowerSyncModule (StreamEvents)
/// Host-provided GlobalEventEmitter sender for incremental /sync/stream.
/// Pass the active {@code LynxView} (or any object implementing
/// {@code sendGlobalEvent:withParams:}). Autolink does not pass the view as
/// {@code initWithParam}; showcase {@code ViewController} calls this after
/// creating the view. If no sender is registered, NativeSyncHttp uses the
/// idle-complete fallback. The library does not walk {@code UIWindow}s.
+ (void)setSharedStreamEventSender:(nullable id)sender;
@end

NS_ASSUME_NONNULL_END
