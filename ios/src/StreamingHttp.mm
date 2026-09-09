#import "StreamingHttp.h"

#include "sync_http_policy.h"

namespace {

NSTimeInterval ConnectTimeoutSec() {
  return PS_SYNC_HTTP_CONNECT_TIMEOUT_MS / 1000.0;
}

NSTimeInterval StreamReadTimeoutSec() {
  return PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS / 1000.0;
}

NSUInteger TrailingIncompleteUtf8Bytes(NSData *data) {
  if (data.length == 0) {
    return 0;
  }
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSInteger i = (NSInteger)data.length - 1;
  NSUInteger continuation = 0;
  while (i >= 0 && (bytes[i] & 0xc0) == 0x80) {
    continuation++;
    i--;
  }
  if (i < 0) {
    return data.length;
  }
  uint8_t lead = bytes[i];
  NSUInteger expected = 0;
  if ((lead & 0x80) == 0) {
    expected = 0;
  } else if ((lead & 0xe0) == 0xc0) {
    expected = 1;
  } else if ((lead & 0xf0) == 0xe0) {
    expected = 2;
  } else if ((lead & 0xf8) == 0xf0) {
    expected = 3;
  } else {
    return 0;
  }
  if (continuation < expected) {
    return continuation + 1;
  }
  return 0;
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
  id urlValue = self.request[@"url"];
  if (![urlValue isKindOfClass:[NSString class]] || [(NSString *)urlValue length] == 0) {
    if (self.onError) {
      self.onError(@"httpFetch requires string url");
    }
    return;
  }
  NSURL *url = [NSURL URLWithString:(NSString *)urlValue];
  if (url == nil) {
    if (self.onError) {
      self.onError(@"httpFetch invalid url");
    }
    return;
  }

  NSString *method = @"GET";
  id methodValue = self.request[@"method"];
  if ([methodValue isKindOfClass:[NSString class]] && [(NSString *)methodValue length] > 0) {
    method = [(NSString *)methodValue uppercaseString];
  }

  NSDictionary *headers = nil;
  id headersValue = self.request[@"headers"];
  if ([headersValue isKindOfClass:[NSDictionary class]]) {
    headers = (NSDictionary *)headersValue;
  }

  NSData *bodyData = nil;
  id bodyValue = self.request[@"body"];
  if ([bodyValue isKindOfClass:[NSString class]]) {
    bodyData = [(NSString *)bodyValue dataUsingEncoding:NSUTF8StringEncoding];
  }

  NSMutableURLRequest *urlRequest = [NSMutableURLRequest requestWithURL:url];
  urlRequest.HTTPMethod = method;
  urlRequest.timeoutInterval = StreamReadTimeoutSec();
  urlRequest.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  if (headers != nil) {
    for (id key in headers) {
      if (![key isKindOfClass:[NSString class]]) {
        continue;
      }
      id value = headers[key];
      NSString *headerValue = [value isKindOfClass:[NSString class]] ? (NSString *)value : [value description];
      [urlRequest setValue:headerValue forHTTPHeaderField:(NSString *)key];
    }
  }
    if (bodyData != nil && bodyData.length > 0) {
      urlRequest.HTTPBody = bodyData;
    }

  NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  config.timeoutIntervalForRequest = StreamReadTimeoutSec();
  config.timeoutIntervalForResource = StreamReadTimeoutSec() + ConnectTimeoutSec();
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
  dispatch_async(self.syncQueue, ^{
    if (self.finished || self.headersDelivered) {
      return;
    }
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
  });
  completionHandler(NSURLSessionResponseAllow);
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
    NSUInteger hold = TrailingIncompleteUtf8Bytes(self.utf8Carry);
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
