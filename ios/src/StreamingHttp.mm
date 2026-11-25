#import "StreamingHttp.h"
#import "SyncHttpRequest.h"

#include "sync_http_policy.h"
#include "utf8_hold.h"

namespace {

NSTimeInterval StreamReadTimeoutSec() {
  return PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS / 1000.0;
}

} // namespace

@interface StreamingHttpSession () <NSURLSessionDataDelegate>
@property(nonatomic, strong) NSDictionary *request;
@property(nonatomic, copy) void (^onHeaders)(NSInteger, NSString *_Nullable);
@property(nonatomic, copy) void (^onData)(NSString *);
@property(nonatomic, copy) void (^onEnd)(void);
@property(nonatomic, copy) void (^onError)(NSString *);
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSMutableData *utf8Carry;
@property(nonatomic, assign) BOOL headersDelivered;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, strong) dispatch_queue_t syncQueue;
@end

@implementation StreamingHttpSession

- (instancetype)initWithRequest:(NSDictionary *)request
                     onHeaders:(void (^)(NSInteger status, NSString *_Nullable contentType))onHeaders
                        onData:(void (^)(NSString *utf8Chunk))onData
                         onEnd:(void (^)(void))onEnd
                       onError:(void (^)(NSString *message))onError {
  self = [super init];
  if (self) {
    _request = request;
    _onHeaders = [onHeaders copy];
    _onData = [onData copy];
    _onEnd = [onEnd copy];
    _onError = [onError copy];
    _utf8Carry = [NSMutableData data];
    _syncQueue = dispatch_queue_create("com.powersync.StreamingHttp", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)start {
  NSString *requestError = nil;
  NSMutableURLRequest *urlRequest =
      BuildSyncHttpURLRequest(self.request, StreamReadTimeoutSec(), &requestError);
  if (urlRequest == nil) {
    if (self.onError) {
      self.onError(requestError ?: @"httpFetch invalid url");
    }
    return;
  }

  NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  config.timeoutIntervalForRequest = StreamReadTimeoutSec();
#if PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS > 0
  config.timeoutIntervalForResource = PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS / 1000.0;
#endif
  config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
  self.task = [self.session dataTaskWithRequest:urlRequest];
  [self.task resume];
}

- (void)cancel {
  dispatch_async(self.syncQueue, ^{
    if (self.finished) {
      return;
    }
    self.finished = YES;
    [self.task cancel];
    [self.session invalidateAndCancel];
    if (self.onError) {
      self.onError(@"aborted");
    }
  });
}

- (void)finishLockedWithError:(NSString *_Nullable)error {
  if (self.finished) {
    return;
  }
  self.finished = YES;
  if (self.utf8Carry.length > 0 && self.onData) {
    NSString *tail = [[NSString alloc] initWithData:self.utf8Carry encoding:NSUTF8StringEncoding];
    if (tail.length > 0) {
      self.onData(tail);
    }
    self.utf8Carry.length = 0;
  }
  [self.session finishTasksAndInvalidate];
  if (error != nil && self.onError) {
    self.onError(error);
  } else if (self.onEnd) {
    self.onEnd();
  }
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  // Allow the body only after headers are recorded. Completing on this serial
  // queue keeps Darwin RST-after-first-chunk from finishing before onHeaders.
  dispatch_async(self.syncQueue, ^{
    NSURLSessionResponseDisposition disposition = NSURLSessionResponseAllow;
    if (self.finished) {
      disposition = NSURLSessionResponseCancel;
    } else if (!self.headersDelivered) {
      self.headersDelivered = YES;
      NSInteger status = 0;
      NSString *contentType = nil;
      if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        status = http.statusCode;
        contentType = http.allHeaderFields[@"Content-Type"] ?: http.allHeaderFields[@"content-type"];
      }
      if (self.onHeaders) {
        self.onHeaders(status, contentType);
      }
    }
    completionHandler(disposition);
  });
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {
  if (data.length == 0) {
    return;
  }
  dispatch_async(self.syncQueue, ^{
    if (self.finished) {
      return;
    }
    [self.utf8Carry appendData:data];
    NSUInteger hold = (NSUInteger)ps_utf8_trailing_incomplete(
        (const uint8_t *)self.utf8Carry.bytes, (size_t)self.utf8Carry.length);
    NSUInteger complete = self.utf8Carry.length - hold;
    if (complete > 0 && self.onData) {
      NSData *slice = [self.utf8Carry subdataWithRange:NSMakeRange(0, complete)];
      NSString *text = [[NSString alloc] initWithData:slice encoding:NSUTF8StringEncoding];
      if (text.length > 0) {
        self.onData(text);
      }
    }
    if (hold > 0) {
      NSData *remain = [self.utf8Carry subdataWithRange:NSMakeRange(complete, hold)];
      [self.utf8Carry setData:remain];
    } else {
      self.utf8Carry.length = 0;
    }
  });
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  dispatch_async(self.syncQueue, ^{
    if (error != nil && error.code != NSURLErrorCancelled) {
      [self finishLockedWithError:error.localizedDescription ?: @"request failed"];
    } else {
      [self finishLockedWithError:nil];
    }
  });
}

@end
