#import "NativeSyncHttp.h"

#include "sync_http/sync_http_engine.h"

#include <memory>
#include <string>

namespace {

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
  if (value.empty()) {
    return @"";
  }
  NSString* result = [[NSString alloc] initWithBytes:value.data()
                                              length:value.size()
                                            encoding:NSUTF8StringEncoding];
  return result != nil ? result : @"";
}

ps_sync_http::HttpRequest RequestFromDict(NSDictionary* request) {
  ps_sync_http::HttpRequest out;
  if (![request isKindOfClass:[NSDictionary class]]) {
    return out;
  }
  id urlValue = request[@"url"];
  if ([urlValue isKindOfClass:[NSString class]]) {
    out.url = Utf8FromNSString((NSString*)urlValue);
  }
  id methodValue = request[@"method"];
  if ([methodValue isKindOfClass:[NSString class]]) {
    out.method = Utf8FromNSString((NSString*)methodValue);
  }
  id headersValue = request[@"headers"];
  if ([headersValue isKindOfClass:[NSDictionary class]]) {
    NSDictionary* headers = (NSDictionary*)headersValue;
    for (id key in headers) {
      if (![key isKindOfClass:[NSString class]]) {
        continue;
      }
      id val = headers[key];
      if (val == nil || [val isKindOfClass:[NSNull class]]) {
        continue;
      }
      NSString* strVal = [val isKindOfClass:[NSString class]] ? (NSString*)val : [val description];
      out.headers.emplace_back(Utf8FromNSString((NSString*)key), Utf8FromNSString(strVal));
    }
  }
  id bodyValue = request[@"body"];
  if ([bodyValue isKindOfClass:[NSString class]]) {
    out.body = Utf8FromNSString((NSString*)bodyValue);
  } else if ([bodyValue isKindOfClass:[NSData class]]) {
    NSData* data = (NSData*)bodyValue;
    if (data.length > 0) {
      const auto* ptr = static_cast<const char*>(data.bytes);
      out.body.assign(ptr, ptr + data.length);
    }
  }
  return out;
}

NSDictionary* EnvelopeToDict(const ps_sync_http::HttpResponseEnvelope& env) {
  NSMutableDictionary* dict = [@{
    @"ok" : @(env.ok),
    @"status" : @(env.status),
    @"statusText" : NSStringFromUtf8(env.status_text),
    @"body" : NSStringFromUtf8(env.body),
    @"idleComplete" : @(env.idle_complete),
  } mutableCopy];
  if (!env.content_type.empty()) {
    dict[@"contentType"] = NSStringFromUtf8(env.content_type);
  }
  if (!env.streaming_id.empty()) {
    dict[@"streamingId"] = NSStringFromUtf8(env.streaming_id);
  }
  if (env.has_body_base64) {
    dict[@"bodyBase64"] = NSStringFromUtf8(env.body_base64);
  }
  if (!env.ok || !env.message.empty()) {
    dict[@"message"] = NSStringFromUtf8(env.message);
  }
  return dict;
}

}  // namespace

// LynxView declares sendGlobalEvent:withParams:, but this translation unit does
// not import Lynx headers (pod TUs and host fixture tests compile without them).
@protocol PSLynxStreamEventSender
- (void)sendGlobalEvent:(NSString*)name withParams:(id)params;
@end

@interface NativeSyncHttp ()
@property(nonatomic, strong, nullable) id streamEventSender;
@end

@implementation NativeSyncHttp {
  std::unique_ptr<ps_sync_http::SyncHttpEngine> _engine;
}

static __weak id g_sharedStreamEventSender = nil;

+ (void)setSharedStreamEventSender:(id)sender {
  g_sharedStreamEventSender = sender;
}

- (instancetype)initWithEventSender:(id)sender {
  if (self = [super init]) {
    _streamEventSender = sender;
    _engine = std::make_unique<ps_sync_http::SyncHttpEngine>();
  }
  return self;
}

- (void)dealloc {
  if (_engine) {
    _engine->Shutdown();
  }
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

- (void)fetch:(NSDictionary*)request callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  if (cb == nil) {
    return;
  }
  id<PSLynxStreamEventSender> senderObj = [self resolveStreamEventSender];
  ps_sync_http::StreamEventSender eventSender;
  if (senderObj != nil) {
    __weak id<PSLynxStreamEventSender> weakSender = senderObj;
    eventSender = [weakSender](const ps_sync_http::StreamEvent& ev) {
      @autoreleasepool {
        id<PSLynxStreamEventSender> strongSender = weakSender;
        if (strongSender == nil) {
          return;
        }
        NSMutableDictionary* payload = [@{@"event" : NSStringFromUtf8(ev.event)} mutableCopy];
        if (ev.event == PS_SYNC_HTTP_EVENT_ON_DATA) {
          payload[@"data"] = NSStringFromUtf8(ev.data);
        } else if (ev.event == PS_SYNC_HTTP_EVENT_ON_ERROR) {
          payload[@"error"] = NSStringFromUtf8(ev.error);
        }
        [strongSender sendGlobalEvent:NSStringFromUtf8(ev.stream_id) withParams:@[ payload ]];
      }
    };
  }

  _engine->Fetch(RequestFromDict(request), std::move(eventSender),
                 [cb](ps_sync_http::HttpResponseEnvelope env) {
                   @autoreleasepool {
                     cb(EnvelopeToDict(env));
                   }
                 });
}

- (void)abort:(NSString*)streamId callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  _engine->Abort(Utf8FromNSString(streamId));
  if (cb != nil) {
    @autoreleasepool {
      cb(@{@"ok" : @YES});
    }
  }
}

@end
