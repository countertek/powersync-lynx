#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Incremental HTTP for PowerSync NDJSON sync streams.
/// Keeps the connection open and delivers UTF-8 string chunks via the listener
/// (no idle-complete batching; no ResponseBody.bytes hang).
@interface StreamingHttpSession : NSObject

- (instancetype)initWithRequest:(NSDictionary *)request
                     onHeaders:(void (^)(NSInteger status, NSString *_Nullable contentType))onHeaders
                        onData:(void (^)(NSString *utf8Chunk))onData
                         onEnd:(void (^)(void))onEnd
                       onError:(void (^)(NSString *message))onError;

- (void)start;
- (void)cancel;

@end

NS_ASSUME_NONNULL_END
