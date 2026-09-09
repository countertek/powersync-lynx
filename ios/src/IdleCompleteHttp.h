#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Idle-complete HTTP GET/POST for NDJSON sync streams that never send a normal
/// ResponseBody end. Fallback behind streamingId (ADR-0003). Policy constants
/// live in shared/sync_http_policy.h.
FOUNDATION_EXPORT NSDictionary *IdleCompleteHttpFetch(NSDictionary *request);

NS_ASSUME_NONNULL_END
