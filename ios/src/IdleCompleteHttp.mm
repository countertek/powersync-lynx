#import "IdleCompleteHttp.h"

#include "sync_http_policy.h"
#include "sync_http_session.h"

#include <string>

namespace {

NSTimeInterval IdleCompleteSec() {
  return PS_SYNC_HTTP_IDLE_COMPLETE_MS / 1000.0;
}

NSTimeInterval ConnectTimeoutSec() {
  return PS_SYNC_HTTP_CONNECT_TIMEOUT_MS / 1000.0;
}

NSTimeInterval BufferedTimeoutSec() {
  return PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS / 1000.0;
}

std::string Utf8FromNSString(NSString* value) {
  if (value == nil) {
    return {};
  }
  NSData* data = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil || data.length == 0) {
    return {};
  }
  const auto* bytes = static_cast<const char*>(data.bytes);
  return std::string(bytes, bytes + data.length);
}

NSString* HeaderValue(NSDictionary* headers, NSString* name) {
  if (headers == nil || ![headers isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSString* want = [name lowercaseString];
  for (id key in headers) {
    if (![key isKindOfClass:[NSString class]]) {
      continue;
    }
    if ([[(NSString*)key lowercaseString] isEqualToString:want]) {
      id value = headers[key];
      return [value isKindOfClass:[NSString class]] ? (NSString*)value : [value description];
    }
  }
  return nil;
}

BOOL LooksLikeLongLivedHeaders(NSDictionary* headers) {
  NSString* encoding = HeaderValue(headers, @"transfer-encoding");
  NSString* length = HeaderValue(headers, @"content-length");
  NSString* contentType = HeaderValue(headers, @"content-type");
  return ps_sync_http_looks_like_long_lived(
             encoding != nil ? Utf8FromNSString(encoding).c_str() : nullptr,
             length != nil ? Utf8FromNSString(length).c_str() : nullptr,
             contentType != nil ? Utf8FromNSString(contentType).c_str() : nullptr) != 0;
}

NSDictionary* ErrorResult(NSInteger status, NSString* message) {
  NSString* text = message ?: @(PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT);
  NSInteger code = status == 0 ? PS_SYNC_HTTP_FAIL_STATUS : status;
  return @{
    @"ok" : @NO,
    @"status" : @(code),
    @"statusText" : @"",
    @"message" : text,
    @"body" : text,
    @"bodyBase64" : @"",
    @"contentType" : @"",
    @"idleComplete" : @NO,
  };
}

NSDictionary* SuccessResult(NSInteger status, NSString* statusText, NSData* bytes,
                            NSString*_Nullable contentType, BOOL idleComplete) {
  NSString* body = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
  if (body == nil) {
    body = @"";
  }
  NSString* b64 = [bytes base64EncodedStringWithOptions:0] ?: @"";
  return @{
    @"ok" : @YES,
    @"status" : @(status),
    @"statusText" : statusText ?: @"",
    @"body" : body,
    @"bodyBase64" : b64,
    @"contentType" : contentType ?: @"",
    @"idleComplete" : @(idleComplete),
  };
}

}  // namespace

@interface IdleCompleteHttpSession : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, strong) NSMutableData* buffer;
@property(nonatomic, strong, nullable) NSHTTPURLResponse* httpResponse;
@property(nonatomic, strong, nullable) NSError* sessionError;
@property(nonatomic, assign) BOOL useIdleTimer;
@property(nonatomic, assign) NSTimeInterval idleSec;
@property(nonatomic, assign) NSTimeInterval readDeadline;
@property(nonatomic, strong, nullable) dispatch_source_t idleTimer;
@property(nonatomic, strong) dispatch_queue_t syncQueue;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, strong) dispatch_semaphore_t done;
@end

@implementation IdleCompleteHttpSession

- (instancetype)initWithIdleEnabled:(BOOL)idleEnabled readTimeoutSec:(NSTimeInterval)readTimeoutSec {
  self = [super init];
  if (self) {
    _buffer = [NSMutableData data];
    _useIdleTimer = idleEnabled;
    _idleSec = IdleCompleteSec();
    _readDeadline = [NSDate date].timeIntervalSince1970 + readTimeoutSec;
    _syncQueue = dispatch_queue_create("com.powersync.IdleCompleteHttp", DISPATCH_QUEUE_SERIAL);
    _done = dispatch_semaphore_create(0);
    _finished = NO;
  }
  return self;
}

- (void)finishLockedWithError:(NSError*_Nullable)error {
  if (self.finished) {
    return;
  }
  self.finished = YES;
  if (error != nil && self.sessionError == nil) {
    self.sessionError = error;
  }
  if (self.idleTimer != nil) {
    dispatch_source_cancel(self.idleTimer);
    self.idleTimer = nil;
  }
  dispatch_semaphore_signal(self.done);
}

- (void)finishWithError:(NSError*_Nullable)error {
  dispatch_async(self.syncQueue, ^{
    [self finishLockedWithError:error];
  });
}

- (void)armIdleTimer {
  if (!self.useIdleTimer) {
    return;
  }
  dispatch_async(self.syncQueue, ^{
    if (self.finished) {
      return;
    }
    if (self.idleTimer != nil) {
      dispatch_source_cancel(self.idleTimer);
      self.idleTimer = nil;
    }
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.syncQueue);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.idleSec * NSEC_PER_SEC)),
                              DISPATCH_TIME_FOREVER, (int64_t)(0.05 * NSEC_PER_SEC));
    __weak IdleCompleteHttpSession* weakSelf = self;
    dispatch_source_set_event_handler(timer, ^{
      IdleCompleteHttpSession* strongSelf = weakSelf;
      if (strongSelf == nil) {
        return;
      }
      [strongSelf finishLockedWithError:nil];
    });
    self.idleTimer = timer;
    dispatch_resume(timer);
  });
}

- (void)URLSession:(NSURLSession*)session
          dataTask:(NSURLSessionDataTask*)dataTask
didReceiveResponse:(NSURLResponse*)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
    self.httpResponse = (NSHTTPURLResponse*)response;
    if (!self.useIdleTimer && LooksLikeLongLivedHeaders(self.httpResponse.allHeaderFields)) {
      self.useIdleTimer = YES;
    }
  }
  [self armIdleTimer];
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession*)session
          dataTask:(NSURLSessionDataTask*)dataTask
    didReceiveData:(NSData*)data {
  dispatch_async(self.syncQueue, ^{
    if (self.finished) {
      return;
    }
    [self.buffer appendData:data];
  });
  [self armIdleTimer];
}

- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task didCompleteWithError:(NSError*)error {
  [self finishWithError:error];
}

- (NSDictionary*)waitForResult:(BOOL)syncStream {
  NSTimeInterval remaining = self.readDeadline - [NSDate date].timeIntervalSince1970;
  if (remaining < 1.0) {
    remaining = 1.0;
  }
  long waitRc = dispatch_semaphore_wait(
      self.done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(remaining * NSEC_PER_SEC)));
  if (waitRc != 0) {
    dispatch_sync(self.syncQueue, ^{
      [self finishLockedWithError:[NSError errorWithDomain:@"IdleCompleteHttp"
                                                      code:-1
                                                  userInfo:@{
                                                    NSLocalizedDescriptionKey :
                                                        @"idle-complete read deadline exceeded"
                                                  }]];
    });
    dispatch_semaphore_wait(self.done, DISPATCH_TIME_FOREVER);
  }

  __block NSData* bytes = nil;
  __block NSError* error = nil;
  __block NSHTTPURLResponse* response = nil;
  dispatch_sync(self.syncQueue, ^{
    bytes = [self.buffer copy];
    error = self.sessionError;
    response = self.httpResponse;
  });

  if (error != nil && bytes.length == 0) {
    return ErrorResult(-1, error.localizedDescription ?: @"request failed");
  }
  NSInteger status = response != nil ? response.statusCode : -1;
  NSString* statusText = @"";
  NSString* contentType = nil;
  if (response != nil) {
    statusText = [NSHTTPURLResponse localizedStringForStatusCode:response.statusCode] ?: @"";
    contentType = HeaderValue(response.allHeaderFields, @"content-type");
  }
  BOOL idleComplete = syncStream && (error == nil || bytes.length > 0);
  return SuccessResult(status, statusText, bytes, contentType, idleComplete);
}

@end

NSDictionary* IdleCompleteHttpFetch(NSDictionary* request) {
  @autoreleasepool {
    if (request == nil || ![request isKindOfClass:[NSDictionary class]]) {
      return ErrorResult(-1, @"httpFetch request must be an object");
    }
    id urlValue = request[@"url"];
    if (![urlValue isKindOfClass:[NSString class]] || [(NSString*)urlValue length] == 0) {
      return ErrorResult(-1, @"httpFetch requires string url");
    }
    NSURL* url = [NSURL URLWithString:(NSString*)urlValue];
    if (url == nil) {
      return ErrorResult(-1, @"httpFetch invalid url");
    }

    NSString* method = @"GET";
    id methodValue = request[@"method"];
    if ([methodValue isKindOfClass:[NSString class]] && [(NSString*)methodValue length] > 0) {
      method = [(NSString*)methodValue uppercaseString];
    }

    NSDictionary* headers = nil;
    id headersValue = request[@"headers"];
    if ([headersValue isKindOfClass:[NSDictionary class]]) {
      headers = (NSDictionary*)headersValue;
    }

    NSData* bodyData = nil;
    id bodyValue = request[@"body"];
    if ([bodyValue isKindOfClass:[NSString class]]) {
      bodyData = [(NSString*)bodyValue dataUsingEncoding:NSUTF8StringEncoding];
    }

    BOOL syncStream = ps_sync_http_is_sync_stream_url(Utf8FromNSString((NSString*)urlValue).c_str()) != 0;
    NSTimeInterval readTimeoutSec = syncStream ? (IdleCompleteSec() + ConnectTimeoutSec())
                                               : (BufferedTimeoutSec() + ConnectTimeoutSec());

    NSMutableURLRequest* urlRequest = [NSMutableURLRequest requestWithURL:url];
    urlRequest.HTTPMethod = method;
    urlRequest.timeoutInterval = readTimeoutSec;
    urlRequest.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    if (headers != nil) {
      for (id key in headers) {
        if (![key isKindOfClass:[NSString class]]) {
          continue;
        }
        id value = headers[key];
        NSString* headerValue =
            [value isKindOfClass:[NSString class]] ? (NSString*)value : [value description];
        [urlRequest setValue:headerValue forHTTPHeaderField:(NSString*)key];
      }
    }
    if (bodyData != nil && bodyData.length > 0) {
      urlRequest.HTTPBody = bodyData;
    }

    IdleCompleteHttpSession* delegate =
        [[IdleCompleteHttpSession alloc] initWithIdleEnabled:syncStream
                                              readTimeoutSec:readTimeoutSec];
    NSURLSessionConfiguration* config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = readTimeoutSec;
    // Idle-complete is a bounded fallback: resource timeout *is* a total wait.
    // StreamingHttp must not copy this — live /sync/stream uses idle/read only.
    config.timeoutIntervalForResource = readTimeoutSec;
    config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    NSURLSession* session = [NSURLSession sessionWithConfiguration:config
                                                          delegate:delegate
                                                     delegateQueue:nil];
    NSURLSessionDataTask* task = [session dataTaskWithRequest:urlRequest];
    [task resume];
    NSDictionary* result = [delegate waitForResult:syncStream];
    [task cancel];
    [session invalidateAndCancel];
    return result;
  }
}
