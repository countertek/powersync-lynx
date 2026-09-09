#import "NativePowerSyncModule.h"
#import "ios_sync_http_fixtures.h"

#include "ndjson_http_replay.h"
#include "sync_stream_fixtures.h"

#include <cstdio>
#include <string>

@interface NativePowerSyncModule (HttpFixtureVisible)
- (instancetype)initWithParam:(id)param;
- (void)httpFetch:(NSDictionary*)request callback:(void (^)(id))callback;
- (void)httpFetchAbort:(NSString*)streamId callback:(void (^)(id))callback;
@end

@interface RecordingStreamSender : NSObject
@property(nonatomic, strong) NSMutableArray<NSDictionary*>* events;
@property(nonatomic, copy, nullable) void (^onEvent)(void);
- (void)sendGlobalEvent:(NSString*)name withParams:(id)params;
@end

@implementation RecordingStreamSender
- (instancetype)init {
  if (self = [super init]) {
    _events = [NSMutableArray array];
  }
  return self;
}

- (void)sendGlobalEvent:(NSString*)name withParams:(id)params {
  NSDictionary* payload = nil;
  if ([params isKindOfClass:[NSArray class]] && [(NSArray*)params count] > 0) {
    id first = ((NSArray*)params)[0];
    if ([first isKindOfClass:[NSDictionary class]]) {
      payload = first;
    }
  } else if ([params isKindOfClass:[NSDictionary class]]) {
    payload = params;
  }
  NSMutableDictionary* row = [NSMutableDictionary dictionary];
  row[@"name"] = name ?: @"";
  if (payload[@"event"] != nil) {
    row[@"event"] = payload[@"event"];
  }
  if (payload[@"data"] != nil) {
    row[@"data"] = payload[@"data"];
  }
  if (payload[@"error"] != nil) {
    row[@"error"] = payload[@"error"];
  }
  @synchronized(self.events) {
    [self.events addObject:row];
  }
  void (^cb)(void) = self.onEvent;
  if (cb != nil) {
    cb();
  }
}

- (NSArray<NSDictionary*>*)snapshot {
  @synchronized(self.events) {
    return [self.events copy];
  }
}
@end

namespace {

int g_http_failures = 0;

void expect_http(bool cond, const char* what) {
  if (!cond) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++g_http_failures;
  } else {
    std::printf("ok: %s\n", what);
  }
}

NSDictionary* WaitForHttp(void (^launch)(void (^)(id))) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSDictionary* result = nil;
  launch(^(id envelope) {
    result = [envelope isKindOfClass:[NSDictionary class]] ? (NSDictionary*)envelope : nil;
    dispatch_semaphore_signal(done);
  });
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
  return result;
}

bool WaitForEventCount(RecordingStreamSender* sender, NSUInteger count) {
  if ([sender snapshot].count >= count) {
    return true;
  }
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  sender.onEvent = ^{
    if ([sender snapshot].count >= count) {
      dispatch_semaphore_signal(done);
    }
  };
  if ([sender snapshot].count >= count) {
    sender.onEvent = nil;
    return true;
  }
  long timed_out =
      dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
  sender.onEvent = nil;
  return timed_out == 0 && [sender snapshot].count >= count;
}

NSString* JoinedData(NSArray<NSDictionary*>* events) {
  NSMutableString* body = [NSMutableString string];
  for (NSDictionary* row in events) {
    if ([row[@"event"] isEqualToString:@"onData"] &&
        [row[@"data"] isKindOfClass:[NSString class]]) {
      [body appendString:row[@"data"]];
    }
  }
  return body;
}

}  // namespace

int RunSyncHttpFixtureTests(void) {
  @autoreleasepool {
    ps_sync_fixtures::Catalog catalog;
    try {
      catalog = ps_sync_fixtures::load_default();
    } catch (const std::exception& ex) {
      std::fprintf(stderr, "FAIL: iOS load fixtures: %s\n", ex.what());
      return 1;
    }
    const auto* checkpoint = ps_sync_fixtures::find_scenario(catalog, "checkpoint-ops");
    const auto* idle = ps_sync_fixtures::find_scenario(catalog, "idle-complete");
    expect_http(checkpoint != nullptr && idle != nullptr, "iOS loaded shared NDJSON scenarios");
    if (checkpoint == nullptr || idle == nullptr) {
      return g_http_failures == 0 ? 1 : g_http_failures;
    }

    ps_sync_fixtures::ReplayConfig config;
    config.content_type = catalog.content_type;
    config.chunks = checkpoint->chunks;
    ps_sync_fixtures::NdjsonReplayServer stream_server;
    expect_http(stream_server.start(config), "iOS fixture HTTP server starts");
    std::string stream_url = stream_server.url();
    NSString* streamUrl = [NSString stringWithUTF8String:stream_url.c_str()];

    RecordingStreamSender* sender = [RecordingStreamSender new];
    NativePowerSyncModule* streaming_module =
        [[NativePowerSyncModule alloc] initWithParam:sender];
    NSDictionary* headers = WaitForHttp(^(void (^cb)(id)) {
      [streaming_module httpFetch:@{
        @"method" : @"POST",
        @"url" : streamUrl,
        @"headers" : @{@"accept" : @"application/json"},
        @"body" : @"{}",
      }
                         callback:cb];
    });
    expect_http([headers[@"ok"] boolValue], "streaming httpFetch ok");
    NSString* streamingId = headers[@"streamingId"];
    expect_http([streamingId isKindOfClass:[NSString class]] &&
                    [streamingId hasPrefix:@"NativePowerSyncHttpStream"],
                "streaming httpFetch returns streamingId");
    expect_http([headers[@"idleComplete"] boolValue] == NO,
                "streaming envelope idleComplete is false");
    expect_http([headers[@"body"] isKindOfClass:[NSString class]] &&
                    [(NSString*)headers[@"body"] length] == 0,
                "streaming envelope body is empty");

    expect_http(WaitForEventCount(sender, 2), "streaming onData* arrived");
    NSArray<NSDictionary*>* events = [sender snapshot];
    NSMutableArray<NSString*>* names = [NSMutableArray array];
    for (NSDictionary* row in events) {
      if ([row[@"event"] isKindOfClass:[NSString class]]) {
        [names addObject:row[@"event"]];
      }
    }
    expect_http(names.count >= 1 && [names[0] isEqualToString:@"onData"],
                "first GlobalEventEmitter event is onData");
    expect_http(WaitForEventCount(sender, names.count + 1) ||
                    [[sender snapshot].lastObject[@"event"] isEqualToString:@"onEnd"],
                "onEnd follows onData");
    events = [sender snapshot];
    NSString* last = events.lastObject[@"event"];
    expect_http([last isEqualToString:@"onEnd"], "terminal event is onEnd");
    BOOL saw_error = NO;
    for (NSDictionary* row in events) {
      if ([row[@"event"] isEqualToString:@"onError"]) {
        saw_error = YES;
      }
    }
    expect_http(!saw_error, "checkpoint-ops has no onError");
    NSString* streamed = JoinedData(events);
    std::string want = ps_sync_fixtures::joined_body(*checkpoint);
    expect_http([streamed UTF8String] != nullptr &&
                    std::string([streamed UTF8String]) == want,
                "onData chunks concatenate to checkpoint-ops NDJSON");
    stream_server.stop();

    ps_sync_fixtures::ReplayConfig idle_config;
    idle_config.content_type = catalog.content_type;
    idle_config.chunks = idle->chunks;
    ps_sync_fixtures::NdjsonReplayServer idle_server;
    expect_http(idle_server.start(idle_config), "idle-complete fixture HTTP server starts");
    NSString* idleUrl =
        [NSString stringWithUTF8String:idle_server.url().c_str()];
    NativePowerSyncModule* idle_module = [NativePowerSyncModule new];
    NSDictionary* idle_env = WaitForHttp(^(void (^cb)(id)) {
      [idle_module httpFetch:@{
        @"method" : @"POST",
        @"url" : idleUrl,
        @"body" : @"{}",
      }
                    callback:cb];
    });
    expect_http([idle_env[@"ok"] boolValue], "idle-complete httpFetch ok");
    expect_http(idle_env[@"streamingId"] == nil ||
                    ([idle_env[@"streamingId"] isKindOfClass:[NSString class]] &&
                     [(NSString*)idle_env[@"streamingId"] length] == 0),
                "idle-complete envelope has no streamingId");
    expect_http([idle_env[@"idleComplete"] boolValue],
                "idle-complete envelope idleComplete is true");
    expect_http([idle_env[@"body"] isKindOfClass:[NSString class]],
                "idle-complete envelope has UTF-8 body");
    expect_http([idle_env[@"bodyBase64"] isKindOfClass:[NSString class]] &&
                    [(NSString*)idle_env[@"bodyBase64"] length] > 0,
                "idle-complete envelope has bodyBase64");
    std::string idle_want = ps_sync_fixtures::joined_body(*idle);
    NSString* idle_body = idle_env[@"body"];
    expect_http([idle_body UTF8String] != nullptr &&
                    std::string([idle_body UTF8String]) == idle_want,
                "idle-complete body matches fixture NDJSON");
    idle_server.stop();

    RecordingStreamSender* abort_sender = [RecordingStreamSender new];
    NativePowerSyncModule* abort_module =
        [[NativePowerSyncModule alloc] initWithParam:abort_sender];
    ps_sync_fixtures::ReplayConfig hold;
    hold.content_type = catalog.content_type;
    hold.chunks = checkpoint->chunks;
    hold.hold_open = true;
    ps_sync_fixtures::NdjsonReplayServer hold_server;
    expect_http(hold_server.start(hold), "hold-open fixture HTTP server starts");
    NSString* holdUrl =
        [NSString stringWithUTF8String:hold_server.url().c_str()];
    NSDictionary* abort_headers = WaitForHttp(^(void (^cb)(id)) {
      [abort_module httpFetch:@{
        @"method" : @"GET",
        @"url" : holdUrl,
      }
                     callback:cb];
    });
    NSString* abort_id = abort_headers[@"streamingId"];
    expect_http([abort_id isKindOfClass:[NSString class]],
                "abort path received streamingId");
    expect_http(WaitForEventCount(abort_sender, 1), "abort path got initial onData");
    NSUInteger before_abort = [abort_sender snapshot].count;
    WaitForHttp(^(void (^cb)(id)) {
      [abort_module httpFetchAbort:abort_id callback:cb];
    });
    expect_http(WaitForEventCount(abort_sender, before_abort + 2),
                "abort emits onError then onEnd");
    NSArray<NSDictionary*>* abort_events = [abort_sender snapshot];
    NSString* abort_last = abort_events.lastObject[@"event"];
    BOOL abort_error = NO;
    for (NSDictionary* row in abort_events) {
      if ([row[@"event"] isEqualToString:@"onError"]) {
        abort_error = YES;
      }
    }
    expect_http(abort_error, "abort after headers emits onError");
    expect_http([abort_last isEqualToString:@"onEnd"],
                "abort terminal sequence ends with onEnd");
    hold_server.stop();
  }
  return g_http_failures;
}
