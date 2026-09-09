#import "NativePowerSyncModule.h"

NS_ASSUME_NONNULL_BEGIN

@interface NativePowerSyncModule (StreamEvents)
/// Hosts should call this with the active LynxView so incremental /sync/stream
/// can post onData via sendGlobalEvent (Lynx Callback is one-shot).
+ (void)setSharedStreamEventSender:(nullable id)sender;
@end

NS_ASSUME_NONNULL_END
