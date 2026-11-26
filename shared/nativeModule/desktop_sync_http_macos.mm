#import <Foundation/Foundation.h>

#include "desktop_sync_http.h"
#include "sync_http_policy.h"
#include "sync_http_session.h"

#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {

NSTimeInterval StreamReadTimeoutSec() {
  return PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS / 1000.0;
}

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

NSString* NSStringFromUtf8(const std::string& value) {
  return [[NSString alloc] initWithBytes:value.data()
                                  length:value.size()
                                encoding:NSUTF8StringEncoding];
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
      return [value isKindOfClass:[NSString class]] ? (NSString*)value
                                                    : [value description];
    }
  }
  return nil;
}

BOOL LooksLikeLongLivedHeaders(NSDictionary* headers) {
  NSString* encoding = HeaderValue(headers, @"transfer-encoding");
  NSString* length = HeaderValue(headers, @"content-length");
  NSString* contentType = HeaderValue(headers, @"content-type");
  const std::string enc = Utf8FromNSString(encoding);
  const std::string len = Utf8FromNSString(length);
  const std::string ct = Utf8FromNSString(contentType);
  return ps_sync_http_looks_like_long_lived(
             encoding != nil ? enc.c_str() : nullptr,
             length != nil ? len.c_str() : nullptr,
             contentType != nil ? ct.c_str() : nullptr) != 0;
}

NSMutableURLRequest* BuildURLRequest(
    const ps_desktop_http::HttpRequest& request, NSTimeInterval timeoutInterval,
    std::string* errorOut) {
  if (request.url.empty()) {
    if (errorOut != nullptr) {
      *errorOut = "httpFetch requires string url";
    }
    return nil;
  }
  NSString* nsUrlStr = NSStringFromUtf8(request.url);
  NSURL* url = nsUrlStr != nil ? [NSURL URLWithString:nsUrlStr] : nil;
  if (url == nil) {
    if (errorOut != nullptr) {
      *errorOut = "httpFetch invalid url";
    }
    return nil;
  }

  NSString* method = NSStringFromUtf8(
      request.method.empty() ? std::string("GET") : request.method);
  if (method == nil || method.length == 0) {
    method = @"GET";
  } else {
    method = [method uppercaseString];
  }

  NSMutableURLRequest* urlRequest = [NSMutableURLRequest requestWithURL:url];
  urlRequest.HTTPMethod = method;
  urlRequest.timeoutInterval = timeoutInterval;
  urlRequest.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;

  for (const auto& kv : request.headers) {
    NSString* key = NSStringFromUtf8(kv.first);
    NSString* val = NSStringFromUtf8(kv.second);
    if (key != nil && key.length > 0 && val != nil) {
      [urlRequest setValue:val forHTTPHeaderField:key];
    }
  }
  if (!request.body.empty()) {
    urlRequest.HTTPBody = [NSData dataWithBytes:request.body.data()
                                         length:request.body.size()];
  }
  return urlRequest;
}

}  // namespace

@interface PSDesktopStreamingDelegate : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, strong, nullable) NSURLSession* session;
@property(nonatomic, strong, nullable) NSURLSessionDataTask* task;
@property(nonatomic, assign) BOOL headersDelivered;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, strong) dispatch_queue_t syncQueue;
- (instancetype)initWithCallbacks:(ps_desktop_http::PlatformStreamCallbacks)callbacks;
- (void)startWithRequest:(NSMutableURLRequest*)urlRequest;
- (void)cancel;
@end

@implementation PSDesktopStreamingDelegate {
  ps_desktop_http::PlatformStreamCallbacks _callbacks;
}

- (instancetype)initWithCallbacks:(ps_desktop_http::PlatformStreamCallbacks)callbacks {
  if (self = [super init]) {
    _callbacks = std::move(callbacks);
    _syncQueue = dispatch_queue_create("com.powersync.DesktopStreamingHttp",
                                       DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)startWithRequest:(NSMutableURLRequest*)urlRequest {
  NSURLSessionConfiguration* config =
      [NSURLSessionConfiguration ephemeralSessionConfiguration];
  config.timeoutIntervalForRequest = StreamReadTimeoutSec();
#if PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS > 0
  config.timeoutIntervalForResource =
      PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS / 1000.0;
#endif
  config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  self.session = [NSURLSession sessionWithConfiguration:config
                                               delegate:self
                                          delegateQueue:nil];
  self.task = [self.session dataTaskWithRequest:urlRequest];
  [self.task resume];
}

- (void)clearCallbacksLocked {
  _callbacks.on_headers = nullptr;
  _callbacks.on_bytes = nullptr;
  _callbacks.on_end = nullptr;
  _callbacks.on_error = nullptr;
}

- (void)cancel {
  dispatch_async(self.syncQueue, ^{
    if (self.finished) {
      return;
    }
    self.finished = YES;
    [self.task cancel];
    [self.session invalidateAndCancel];
    self.task = nil;
    self.session = nil;
    auto onError = std::move(self->_callbacks.on_error);
    [self clearCallbacksLocked];
    if (onError) {
      onError(PS_SYNC_HTTP_ABORT_MESSAGE);
    }
  });
}

- (void)finishLockedWithError:(NSString*)error {
  if (self.finished) {
    return;
  }
  self.finished = YES;
  [self.session finishTasksAndInvalidate];
  self.task = nil;
  self.session = nil;
  auto onError = std::move(_callbacks.on_error);
  auto onEnd = std::move(_callbacks.on_end);
  [self clearCallbacksLocked];
  if (error != nil && onError) {
    onError(Utf8FromNSString(error));
  } else if (onEnd) {
    onEnd();
  }
}

- (void)URLSession:(NSURLSession*)session
              dataTask:(NSURLSessionDataTask*)dataTask
    didReceiveResponse:(NSURLResponse*)response
     completionHandler:
         (void (^)(NSURLSessionResponseDisposition))completionHandler {
  (void)session;
  (void)dataTask;
  // Allow the body only after headers are recorded on the serial queue so
  // RST-after-first-chunk never completes before on_headers runs.
  dispatch_async(self.syncQueue, ^{
    NSURLSessionResponseDisposition disposition = NSURLSessionResponseAllow;
    if (self.finished) {
      disposition = NSURLSessionResponseCancel;
    } else if (!self.headersDelivered) {
      self.headersDelivered = YES;
      int status = 0;
      std::string statusText;
      std::string contentType;
      if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSHTTPURLResponse* http = (NSHTTPURLResponse*)response;
        status = static_cast<int>(http.statusCode);
        NSString* reason =
            [NSHTTPURLResponse localizedStringForStatusCode:http.statusCode];
        statusText = Utf8FromNSString(reason);
        contentType =
            Utf8FromNSString(HeaderValue(http.allHeaderFields, @"content-type"));
      }
      if (self->_callbacks.on_headers) {
        self->_callbacks.on_headers(status, statusText, contentType);
      }
    }
    completionHandler(disposition);
  });
}

- (void)URLSession:(NSURLSession*)session
          dataTask:(NSURLSessionDataTask*)dataTask
    didReceiveData:(NSData*)data {
  (void)session;
  (void)dataTask;
  if (data == nil || data.length == 0) {
    return;
  }
  NSData* copy = [data copy];
  dispatch_async(self.syncQueue, ^{
    if (self.finished || !self->_callbacks.on_bytes) {
      return;
    }
    self->_callbacks.on_bytes(static_cast<const uint8_t*>(copy.bytes),
                              static_cast<size_t>(copy.length));
  });
}

- (void)URLSession:(NSURLSession*)session
                    task:(NSURLSessionTask*)task
    didCompleteWithError:(NSError*)error {
  (void)session;
  (void)task;
  dispatch_async(self.syncQueue, ^{
    if (error != nil && error.code != NSURLErrorCancelled) {
      [self finishLockedWithError:error.localizedDescription ?: @"request failed"];
    } else if (error != nil && error.code == NSURLErrorCancelled) {
      [self finishLockedWithError:@(PS_SYNC_HTTP_ABORT_MESSAGE)];
    } else {
      [self finishLockedWithError:nil];
    }
  });
}

@end

@interface PSDesktopIdleDelegate : NSObject <NSURLSessionDataDelegate>
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

@implementation PSDesktopIdleDelegate

- (instancetype)initWithIdleEnabled:(BOOL)idleEnabled
                     readTimeoutSec:(NSTimeInterval)readTimeoutSec {
  if (self = [super init]) {
    _buffer = [NSMutableData data];
    _useIdleTimer = idleEnabled;
    _idleSec = IdleCompleteSec();
    _readDeadline = [NSDate date].timeIntervalSince1970 + readTimeoutSec;
    _syncQueue = dispatch_queue_create("com.powersync.DesktopIdleHttp",
                                       DISPATCH_QUEUE_SERIAL);
    _done = dispatch_semaphore_create(0);
    _finished = NO;
  }
  return self;
}

- (void)finishLockedWithError:(NSError*)error {
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

- (void)finishWithError:(NSError*)error {
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
    dispatch_source_t timer =
        dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.syncQueue);
    dispatch_source_set_timer(
        timer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.idleSec * NSEC_PER_SEC)),
        DISPATCH_TIME_FOREVER, (int64_t)(0.05 * NSEC_PER_SEC));
    __weak PSDesktopIdleDelegate* weakSelf = self;
    dispatch_source_set_event_handler(timer, ^{
      PSDesktopIdleDelegate* strongSelf = weakSelf;
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
     completionHandler:
         (void (^)(NSURLSessionResponseDisposition))completionHandler {
  (void)session;
  (void)dataTask;
  if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
    self.httpResponse = (NSHTTPURLResponse*)response;
    if (!self.useIdleTimer &&
        LooksLikeLongLivedHeaders(self.httpResponse.allHeaderFields)) {
      self.useIdleTimer = YES;
    }
  }
  [self armIdleTimer];
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession*)session
          dataTask:(NSURLSessionDataTask*)dataTask
    didReceiveData:(NSData*)data {
  (void)session;
  (void)dataTask;
  NSData* copy = [data copy];
  dispatch_async(self.syncQueue, ^{
    if (self.finished) {
      return;
    }
    [self.buffer appendData:copy];
  });
  [self armIdleTimer];
}

- (void)URLSession:(NSURLSession*)session
                    task:(NSURLSessionTask*)task
    didCompleteWithError:(NSError*)error {
  (void)session;
  (void)task;
  [self finishWithError:error];
}

- (ps_desktop_http::HttpResponseEnvelope)waitForResult:(BOOL)syncStream {
  NSTimeInterval remaining =
      self.readDeadline - [NSDate date].timeIntervalSince1970;
  if (remaining < 1.0) {
    remaining = 1.0;
  }
  long waitRc = dispatch_semaphore_wait(
      self.done,
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(remaining * NSEC_PER_SEC)));
  if (waitRc != 0) {
    dispatch_sync(self.syncQueue, ^{
      [self finishLockedWithError:
                [NSError errorWithDomain:@"DesktopIdleHttp"
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
    return ps_desktop_http::MakeIdleErrorEnvelope(
        -1, Utf8FromNSString(error.localizedDescription ?: @"request failed"));
  }
  int status = response != nil ? static_cast<int>(response.statusCode) : -1;
  std::string statusText;
  std::string contentType;
  if (response != nil) {
    NSString* reason =
        [NSHTTPURLResponse localizedStringForStatusCode:response.statusCode];
    statusText = Utf8FromNSString(reason);
    contentType =
        Utf8FromNSString(HeaderValue(response.allHeaderFields, @"content-type"));
  }
  std::vector<uint8_t> raw;
  if (bytes != nil && bytes.length > 0) {
    const auto* ptr = static_cast<const uint8_t*>(bytes.bytes);
    raw.assign(ptr, ptr + bytes.length);
  }
  const bool idleComplete =
      (syncStream == YES) && (error == nil || !raw.empty());
  return ps_desktop_http::MakeIdleSuccessEnvelope(
      status, statusText, raw, contentType, idleComplete);
}

@end

namespace ps_desktop_http {

namespace {

class MacStreamTask final : public PlatformStreamTask {
 public:
  explicit MacStreamTask(PSDesktopStreamingDelegate* delegate)
      : delegate_(delegate) {}

  void Cancel() override {
    if (delegate_ != nil) {
      [delegate_ cancel];
    }
  }

 private:
  PSDesktopStreamingDelegate* delegate_;
};

}  // namespace

std::shared_ptr<PlatformStreamTask> StartPlatformStreamingRequest(
    const HttpRequest& request, PlatformStreamCallbacks callbacks) {
  @autoreleasepool {
    std::string reqError;
    NSMutableURLRequest* urlRequest =
        BuildURLRequest(request, StreamReadTimeoutSec(), &reqError);
    if (urlRequest == nil) {
      if (callbacks.on_error) {
        callbacks.on_error(reqError.empty() ? "httpFetch invalid url" : reqError);
      }
      return std::make_shared<MacStreamTask>(nil);
    }

    PSDesktopStreamingDelegate* delegate =
        [[PSDesktopStreamingDelegate alloc] initWithCallbacks:std::move(callbacks)];
    auto task = std::make_shared<MacStreamTask>(delegate);
    [delegate startWithRequest:urlRequest];
    return task;
  }
}

void StartPlatformIdleCompleteRequest(const HttpRequest& request,
                                      bool is_sync_stream,
                                      EnvelopeCallback callback) {
  if (!callback) {
    return;
  }
  HttpRequest reqCopy = request;
  EnvelopeCallback cbCopy = std::move(callback);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      NSTimeInterval readTimeoutSec =
          is_sync_stream ? (IdleCompleteSec() + ConnectTimeoutSec())
                         : (BufferedTimeoutSec() + ConnectTimeoutSec());
      std::string reqError;
      NSMutableURLRequest* urlRequest =
          BuildURLRequest(reqCopy, readTimeoutSec, &reqError);
      if (urlRequest == nil) {
        cbCopy(MakeIdleErrorEnvelope(
            -1, reqError.empty() ? "httpFetch invalid url" : reqError));
        return;
      }

      PSDesktopIdleDelegate* delegate = [[PSDesktopIdleDelegate alloc]
          initWithIdleEnabled:is_sync_stream ? YES : NO
               readTimeoutSec:readTimeoutSec];
      NSURLSessionConfiguration* config =
          [NSURLSessionConfiguration ephemeralSessionConfiguration];
      config.timeoutIntervalForRequest = readTimeoutSec;
      // Idle-complete is a bounded fallback: resource timeout is a total wait.
      // StreamingHttp must not copy this — live /sync/stream uses idle/read only.
      config.timeoutIntervalForResource = readTimeoutSec;
      config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
      NSURLSession* session = [NSURLSession sessionWithConfiguration:config
                                                            delegate:delegate
                                                       delegateQueue:nil];
      NSURLSessionDataTask* task = [session dataTaskWithRequest:urlRequest];
      [task resume];
      HttpResponseEnvelope result =
          [delegate waitForResult:is_sync_stream ? YES : NO];
      [task cancel];
      [session invalidateAndCancel];
      cbCopy(std::move(result));
    }
  });
}

}  // namespace ps_desktop_http
