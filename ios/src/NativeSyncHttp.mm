#import "NativeSyncHttp.h"
#import "IdleCompleteHttp.h"
#import "StreamingHttp.h"

#include "sync_http_policy.h"
#include "sync_http_session.h"

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

NSString* ErrorText(ps_sync_http_session* session, NSString* message) {
  if (message.length > 0) {
    return message;
  }
  return @(ps_sync_http_session_error_text(session, nullptr));
}

NSDictionary* FailEnvelope(NSString* message) {
  NSString* text = message.length > 0 ? message : @(PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT);
  return @{
    @"ok" : @NO,
    @"status" : @(PS_SYNC_HTTP_FAIL_STATUS),
    @"statusText" : @"",
    @"message" : text,
    @"body" : text,
    @"idleComplete" : @NO,
  };
}

}  // namespace

// LynxView declares sendGlobalEvent:withParams:, but this translation unit does
// not import Lynx headers (pod TUs and Linux fixture tests compile without them).
@protocol PSLynxStreamEventSender
- (void)sendGlobalEvent:(NSString*)name withParams:(id)params;
@end

@interface PSSyncHttpStreamHandle : NSObject {
 @public
  ps_sync_http_session session;
}
@property(nonatomic, copy) NSString* streamId;
@property(nonatomic, copy) void (^callback)(id);
@property(nonatomic, strong, nullable) StreamingHttpSession* io;
@end

@implementation PSSyncHttpStreamHandle
@end

@interface NativeSyncHttp ()
@property(nonatomic, strong, nullable) id streamEventSender;
@property(nonatomic, strong) NSMutableDictionary<NSString*, PSSyncHttpStreamHandle*>* activeStreams;
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

- (id<PSLynxStreamEventSender>)resolveStreamEventSender {
  // Host-provided only: initWithEventSender: / Autolink initWithParam, or
  // +setSharedStreamEventSender: (showcase registers the LynxView). No UIWindow walk.
  if ([self.streamEventSender respondsToSelector:@selector(sendGlobalEvent:withParams:)]) {
    return (id<PSLynxStreamEventSender>)self.streamEventSender;
  }
  if ([g_sharedStreamEventSender respondsToSelector:@selector(sendGlobalEvent:withParams:)]) {
    return (id<PSLynxStreamEventSender>)g_sharedStreamEventSender;
  }
  return nil;
}

- (void)sendStreamEvent:(NSString*)streamId
                  event:(NSString*)event
                   data:(NSString*_Nullable)data
                  error:(NSString*_Nullable)error {
  id<PSLynxStreamEventSender> sender = [self resolveStreamEventSender];
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

- (void)applyEffects:(int)effects
              handle:(PSSyncHttpStreamHandle*)handle
              status:(NSInteger)status
         contentType:(NSString*_Nullable)contentType
                data:(NSString*_Nullable)data
               error:(NSString*_Nullable)error {
  if (handle == nil) {
    return;
  }
  NSString* streamId = handle.streamId;
  void (^callback)(id) = handle.callback;
  if ((effects & PS_SYNC_HTTP_EFFECT_CALLBACK_HEADERS) != 0 && callback != nil) {
    NSMutableDictionary* result = [@{
      @"ok" : @YES,
      @"status" : @(status),
      @"statusText" : @"",
      @"body" : @"",
      @"streamingId" : streamId ?: @"",
      @"idleComplete" : @NO,
    } mutableCopy];
    if (contentType != nil) {
      result[@"contentType"] = contentType;
    }
    @autoreleasepool {
      callback(result);
    }
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_CALLBACK_FAIL) != 0 && callback != nil) {
    @autoreleasepool {
      callback(FailEnvelope(ErrorText(&handle->session, error)));
    }
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_DATA) != 0) {
    [self sendStreamEvent:streamId
                    event:@(PS_SYNC_HTTP_EVENT_ON_DATA)
                     data:data
                    error:nil];
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_ERROR) != 0) {
    [self sendStreamEvent:streamId
                    event:@(PS_SYNC_HTTP_EVENT_ON_ERROR)
                     data:nil
                    error:ErrorText(&handle->session, error)];
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_END) != 0) {
    [self sendStreamEvent:streamId event:@(PS_SYNC_HTTP_EVENT_ON_END) data:nil error:nil];
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_CANCEL_IO) != 0) {
    [handle.io cancel];
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_DROP) != 0) {
    @synchronized(self.activeStreams) {
      if (streamId != nil) {
        [self.activeStreams removeObjectForKey:streamId];
      }
    }
  }
}

- (void)fetch:(NSDictionary*)request callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  if (cb == nil) {
    return;
  }
  BOOL syncStream = UrlLooksLikeSyncStream(request);
  id sender = syncStream ? [self resolveStreamEventSender] : nil;
  int route = ps_sync_http_route(syncStream ? 1 : 0, sender != nil ? 1 : 0);
  if (route == PS_SYNC_HTTP_ROUTE_STREAMING) {
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
  PSSyncHttpStreamHandle* handle = [PSSyncHttpStreamHandle new];
  handle.streamId = streamId;
  handle.callback = callback;
  ps_sync_http_session_init(&handle->session);
  __weak NativeSyncHttp* weakSelf = self;
  __weak PSSyncHttpStreamHandle* weakHandle = handle;
  handle.io = [[StreamingHttpSession alloc]
      initWithRequest:request
            onHeaders:^(NSInteger status, NSString*_Nullable contentType) {
              PSSyncHttpStreamHandle* strongHandle = weakHandle;
              NativeSyncHttp* strongSelf = weakSelf;
              if (strongHandle == nil || strongSelf == nil) {
                return;
              }
              int effects = ps_sync_http_session_on_headers(&strongHandle->session);
              [strongSelf applyEffects:effects
                                handle:strongHandle
                                status:status
                           contentType:contentType
                                  data:nil
                                 error:nil];
            }
               onData:^(NSString* utf8Chunk) {
                 PSSyncHttpStreamHandle* strongHandle = weakHandle;
                 NativeSyncHttp* strongSelf = weakSelf;
                 if (strongHandle == nil || strongSelf == nil || utf8Chunk.length == 0) {
                   return;
                 }
                 int effects = ps_sync_http_session_on_data(&strongHandle->session);
                 [strongSelf applyEffects:effects
                                   handle:strongHandle
                                   status:0
                              contentType:nil
                                     data:utf8Chunk
                                    error:nil];
               }
                onEnd:^{
                  PSSyncHttpStreamHandle* strongHandle = weakHandle;
                  NativeSyncHttp* strongSelf = weakSelf;
                  if (strongHandle == nil || strongSelf == nil) {
                    return;
                  }
                  int effects = ps_sync_http_session_on_end(&strongHandle->session);
                  [strongSelf applyEffects:effects
                                    handle:strongHandle
                                    status:0
                               contentType:nil
                                      data:nil
                                     error:nil];
                }
              onError:^(NSString* message) {
                PSSyncHttpStreamHandle* strongHandle = weakHandle;
                NativeSyncHttp* strongSelf = weakSelf;
                if (strongHandle == nil || strongSelf == nil) {
                  return;
                }
                int effects = ps_sync_http_session_on_error(&strongHandle->session);
                [strongSelf applyEffects:effects
                                  handle:strongHandle
                                  status:0
                             contentType:nil
                                    data:nil
                                   error:message];
              }];
  @synchronized(self.activeStreams) {
    self.activeStreams[streamId] = handle;
  }
  [handle.io start];
}

- (void)abort:(NSString*)streamId callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  PSSyncHttpStreamHandle* handle = nil;
  @synchronized(self.activeStreams) {
    handle = streamId != nil ? self.activeStreams[streamId] : nil;
  }
  if (handle != nil) {
    int effects = ps_sync_http_session_abort(&handle->session);
    [self applyEffects:effects handle:handle status:0 contentType:nil data:nil error:nil];
  }
  if (cb != nil) {
    @autoreleasepool {
      cb(@{@"ok" : @YES});
    }
  }
}

@end
