#import "NativeSyncHttp.h"
#import "IdleCompleteHttp.h"
#import "StreamingHttp.h"

#include "sync_http_policy.h"

#include <atomic>
#include <string>

namespace {

std::atomic_long g_stream_counter{0};

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

BOOL UrlLooksLikeSyncStream(NSDictionary* request) {
  id urlValue = request[@"url"];
  if (![urlValue isKindOfClass:[NSString class]]) {
    return NO;
  }
  return ps_sync_http_is_sync_stream_url(Utf8FromNSString((NSString*)urlValue).c_str()) != 0;
}

}  // namespace

@interface NativeSyncHttp ()
@property(nonatomic, strong, nullable) id streamEventSender;
@property(nonatomic, strong) NSMutableDictionary<NSString*, StreamingHttpSession*>* activeStreams;
@end

@implementation NativeSyncHttp

static __weak id g_sharedStreamEventSender = nil;

+ (void)setSharedStreamEventSender:(id)sender {
  g_sharedStreamEventSender = sender;
}

- (instancetype)initWithEventSender:(id)sender {
  if (self = [super init]) {
    _streamEventSender = sender;
    _activeStreams = [NSMutableDictionary dictionary];
  }
  return self;
}

- (id)resolveStreamEventSender {
  // Host-provided only: initWithEventSender: / Autolink initWithParam, or
  // +setSharedStreamEventSender: (showcase registers the LynxView). No UIWindow walk.
  if ([self.streamEventSender respondsToSelector:@selector(sendGlobalEvent:withParams:)]) {
    return self.streamEventSender;
  }
  if ([g_sharedStreamEventSender respondsToSelector:@selector(sendGlobalEvent:withParams:)]) {
    return g_sharedStreamEventSender;
  }
  return nil;
}

- (void)sendStreamEvent:(NSString*)streamId
                  event:(NSString*)event
                   data:(NSString*_Nullable)data
                  error:(NSString*_Nullable)error {
  id sender = [self resolveStreamEventSender];
  if (sender == nil) {
    return;
  }
  NSMutableDictionary* payload = [@{@"event" : event} mutableCopy];
  if (data != nil) {
    payload[@"data"] = data;
  }
  if (error != nil) {
    payload[@"error"] = error;
  }
  [sender sendGlobalEvent:streamId withParams:@[ payload ]];
}

- (void)fetch:(NSDictionary*)request callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  if (cb == nil) {
    return;
  }
  BOOL syncStream = UrlLooksLikeSyncStream(request);
  id sender = syncStream ? [self resolveStreamEventSender] : nil;
  if (syncStream && sender != nil) {
    [self fetchStreaming:request callback:cb];
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSDictionary* result = IdleCompleteHttpFetch(request);
    @autoreleasepool {
      cb(result);
    }
  });
}

- (void)fetchStreaming:(NSDictionary*)request callback:(void (^)(id))callback {
  NSString* streamId = [NSString
      stringWithFormat:@"%s%ld", PS_SYNC_HTTP_STREAM_EVENT_PREFIX, g_stream_counter.fetch_add(1)];
  __block BOOL headersSent = NO;
  __weak NativeSyncHttp* weakSelf = self;
  StreamingHttpSession* session = [[StreamingHttpSession alloc]
      initWithRequest:request
            onHeaders:^(NSInteger status, NSString*_Nullable contentType) {
              headersSent = YES;
              NSMutableDictionary* result = [@{
                @"ok" : @YES,
                @"status" : @(status),
                @"statusText" : @"",
                @"body" : @"",
                @"streamingId" : streamId,
                @"idleComplete" : @NO,
              } mutableCopy];
              if (contentType != nil) {
                result[@"contentType"] = contentType;
              }
              @autoreleasepool {
                callback(result);
              }
            }
               onData:^(NSString* utf8Chunk) {
                 NativeSyncHttp* strongSelf = weakSelf;
                 [strongSelf sendStreamEvent:streamId event:@"onData" data:utf8Chunk error:nil];
               }
                onEnd:^{
                  NativeSyncHttp* strongSelf = weakSelf;
                  [strongSelf sendStreamEvent:streamId event:@"onEnd" data:nil error:nil];
                  @synchronized(strongSelf.activeStreams) {
                    [strongSelf.activeStreams removeObjectForKey:streamId];
                  }
                }
              onError:^(NSString* message) {
                NativeSyncHttp* strongSelf = weakSelf;
                if (!headersSent) {
                  @autoreleasepool {
                    callback(@{
                      @"ok" : @NO,
                      @"status" : @(-1),
                      @"statusText" : @"",
                      @"message" : message ?: @"httpFetch stream failed",
                      @"body" : message ?: @"",
                      @"idleComplete" : @NO,
                    });
                  }
                } else {
                  NSString* text = message ?: @"httpFetch stream failed";
                  [strongSelf sendStreamEvent:streamId event:@"onError" data:nil error:text];
                  [strongSelf sendStreamEvent:streamId event:@"onEnd" data:nil error:nil];
                }
                @synchronized(strongSelf.activeStreams) {
                  [strongSelf.activeStreams removeObjectForKey:streamId];
                }
              }];
  @synchronized(self.activeStreams) {
    self.activeStreams[streamId] = session;
  }
  [session start];
}

- (void)abort:(NSString*)streamId callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  StreamingHttpSession* session = nil;
  @synchronized(self.activeStreams) {
    session = self.activeStreams[streamId];
    [self.activeStreams removeObjectForKey:streamId];
  }
  [session cancel];
  if (cb != nil) {
    @autoreleasepool {
      cb(@{@"ok" : @YES});
    }
  }
}

@end
