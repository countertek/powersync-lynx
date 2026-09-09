#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Idle-complete HTTP GET/POST for NDJSON sync streams that never send a normal
/// ResponseBody end. Mirrors Android IdleCompleteHttp / NativePowerSyncModule.httpFetch.
FOUNDATION_EXPORT NSDictionary *IdleCompleteHttpFetch(NSDictionary *request);

NS_ASSUME_NONNULL_END
