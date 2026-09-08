#import "NativePowerSyncModule.h"

@interface NativePowerSyncModule (TestVisible)
+ (NSString*)name;
+ (NSDictionary<NSString*, NSString*>*)methodLookup;
- (void)open:(NSDictionary*)options callback:(void (^)(id))callback;
- (void)close:(NSString*)dbId callback:(void (^)(id))callback;
- (void)execute:(NSString*)dbId
            sql:(NSString*)sql
         params:(NSArray*)params
       callback:(void (^)(id))callback;
- (void)executeBatch:(NSString*)dbId
                 sql:(NSString*)sql
              params:(NSArray*)params
            callback:(void (^)(id))callback;
@end

#include <chrono>
#include <cstdio>

namespace {

int g_failures = 0;

void expect(bool cond, const char* what) {
  if (!cond) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++g_failures;
  } else {
    std::printf("ok: %s\n", what);
  }
}

NSDictionary* WaitFor(void (^launch)(void (^)(id))) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSDictionary* result = nil;
  launch(^(id envelope) {
    result = [envelope isKindOfClass:[NSDictionary class]]
                 ? (NSDictionary*)envelope
                 : nil;
    dispatch_semaphore_signal(done);
  });
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  return result;
}

id FirstCell(NSDictionary* envelope) {
  NSArray* rows = envelope[@"rawRows"];
  if (![rows isKindOfClass:[NSArray class]] || rows.count == 0) {
    return nil;
  }
  NSArray* row = rows[0];
  if (![row isKindOfClass:[NSArray class]] || row.count == 0) {
    return nil;
  }
  return row[0];
}

void PrintEnvelope(const char* label, NSDictionary* envelope) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:envelope
                                                 options:0
                                                   error:&error];
  NSString* rendered =
      data != nil ? [[NSString alloc] initWithData:data
                                          encoding:NSUTF8StringEncoding]
                  : @"<unserializable>";
  std::printf("envelope %s: %s\n", label, [rendered UTF8String]);
  id cell = FirstCell(envelope);
  if (cell != nil) {
    std::printf("  firstCell class=%s value=%s\n",
                [NSStringFromClass([cell class]) UTF8String],
                [[cell description] UTF8String]);
  }
}

}  // namespace

int main() {
  @autoreleasepool {
    NativePowerSyncModule* module = [NativePowerSyncModule new];
    expect([[NativePowerSyncModule name] isEqualToString:@"NativePowerSyncModule"],
           "lookup name is NativePowerSyncModule");
    NSDictionary* methods = [NativePowerSyncModule methodLookup];
    expect(methods[@"open"] != nil && methods[@"close"] != nil &&
               methods[@"execute"] != nil && methods[@"executeBatch"] != nil,
           "methodLookup exposes open/close/execute/executeBatch");

    NSDictionary* opened = WaitFor(^(void (^cb)(id)) {
      [module open:@{@"dbFilename" : @":memory:"} callback:cb];
    });
    PrintEnvelope("open", opened);
    expect([opened[@"ok"] boolValue], "open success ok=true");
    NSString* dbId = opened[@"dbId"];
    expect([dbId isKindOfClass:[NSString class]] && [dbId hasPrefix:@"ps-"],
           "open returns opaque dbId");

    NSDictionary* version = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId
                  sql:@"SELECT powersync_rs_version()"
               params:@[]
             callback:cb];
    });
    PrintEnvelope("powersync_rs_version", version);
    expect([version[@"ok"] boolValue], "core-load: powersync_rs_version ok");
    id version_cell = FirstCell(version);
    expect([version_cell isKindOfClass:[NSString class]] &&
               [(NSString*)version_cell length] > 0,
           "core-load: version text cell");

    NSDictionary* string_typeof = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId
                  sql:@"SELECT typeof(?)"
               params:@[ @"9007199254740993" ]
             callback:cb];
    });
    PrintEnvelope("typeof NSString snowflake", string_typeof);
    expect([string_typeof[@"ok"] boolValue], "NSString snowflake bind ok");
    id string_cell = FirstCell(string_typeof);
    expect([string_cell isKindOfClass:[NSString class]] &&
               [(NSString*)string_cell isEqualToString:@"text"],
           "NSString snowflake BindValue stays TEXT");

    NSDictionary* stored = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId
                  sql:@"SELECT ?"
               params:@[ @"9007199254740993" ]
             callback:cb];
    });
    PrintEnvelope("SELECT NSString snowflake", stored);
    id stored_cell = FirstCell(stored);
    expect([stored_cell isKindOfClass:[NSString class]] &&
               [(NSString*)stored_cell isEqualToString:@"9007199254740993"],
           "NSString snowflake round-trips as TEXT, not INTEGER");

    NSDictionary* outgoing = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId
                  sql:@"SELECT 9007199254740993"
               params:@[]
             callback:cb];
    });
    PrintEnvelope("SELECT 9007199254740993", outgoing);
    expect([outgoing[@"ok"] boolValue], "unsafe INTEGER select ok");
    id outgoing_cell = FirstCell(outgoing);
    expect([outgoing_cell isKindOfClass:[NSDictionary class]],
           "INTEGER past MAX_SAFE_INTEGER maps to tagged __psBig dict");
    expect(![outgoing_cell isKindOfClass:[NSNumber class]],
           "unsafe INTEGER is not boxed as NSNumber");
    expect(![outgoing_cell isKindOfClass:[NSString class]],
           "unsafe INTEGER is not a bare decimal NSString");
    if ([outgoing_cell isKindOfClass:[NSDictionary class]]) {
      NSDictionary* tagged_out = (NSDictionary*)outgoing_cell;
      expect([tagged_out[@"__psBig"] boolValue] &&
                 [tagged_out[@"v"] isKindOfClass:[NSString class]] &&
                 [(NSString*)tagged_out[@"v"]
                     isEqualToString:@"9007199254740993"],
             "tagged INTEGER carries decimal v without coercing to NSNumber");
    }

    NSDictionary* tagged_bind = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId
                  sql:@"SELECT typeof(?)"
               params:@[ @{ @"__psBig" : @YES, @"v" : @"99" } ]
             callback:cb];
    });
    PrintEnvelope("typeof tagged bigint 99", tagged_bind);
    id tagged_type = FirstCell(tagged_bind);
    expect([tagged_type isKindOfClass:[NSString class]] &&
               [(NSString*)tagged_type isEqualToString:@"integer"],
           "tagged __psBig BindValue binds as INTEGER");

    const char nul_bytes[] = {'a', '\0', 'b'};
    NSString* nul_text =
        [[NSString alloc] initWithBytes:nul_bytes
                                 length:3
                               encoding:NSUTF8StringEncoding];
    NSDictionary* nul_round = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId
                  sql:@"SELECT typeof(?), hex(?), length(CAST(? AS BLOB))"
               params:@[ nul_text, nul_text, nul_text ]
             callback:cb];
    });
    PrintEnvelope("embedded NUL text", nul_round);
    expect([nul_round[@"ok"] boolValue], "embedded NUL execute ok");
    NSArray* nul_row = nul_round[@"rawRows"][0];
    expect([nul_row[0] isKindOfClass:[NSString class]] &&
               [(NSString*)nul_row[0] isEqualToString:@"text"],
           "embedded NUL stays TEXT");
    expect([nul_row[1] isKindOfClass:[NSString class]] &&
               [(NSString*)nul_row[1] isEqualToString:@"610062"],
           "embedded NUL round-trips all three UTF-8 bytes");
    expect([nul_row[2] isKindOfClass:[NSNumber class]] &&
               [nul_row[2] intValue] == 3,
           "embedded NUL CAST-to-BLOB length is 3, not truncated at NUL");
    NSDictionary* nul_select = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId sql:@"SELECT ?" params:@[ nul_text ] callback:cb];
    });
    id nul_cell = FirstCell(nul_select);
    expect([nul_cell isKindOfClass:[NSString class]] &&
               [(NSString*)nul_cell length] == 3,
           "embedded NUL NSString round-trips 3 UTF-16 units");

    NSDictionary* safe = WaitFor(^(void (^cb)(id)) {
      [module execute:dbId sql:@"SELECT 42" params:@[] callback:cb];
    });
    PrintEnvelope("SELECT 42", safe);
    id safe_cell = FirstCell(safe);
    expect([safe_cell isKindOfClass:[NSNumber class]] &&
               [safe_cell longLongValue] == 42,
           "safe INTEGER stays NSNumber");

    dispatch_semaphore_t slow_done = dispatch_semaphore_create(0);
    __block BOOL callback_fired = NO;
    const auto start = std::chrono::steady_clock::now();
    [module execute:dbId
                sql:@"WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 "
                    @"FROM t WHERE x < 200000) SELECT count(*) FROM t"
             params:@[]
           callback:^(id) {
             callback_fired = YES;
             dispatch_semaphore_signal(slow_done);
           }];
    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start)
            .count();
    expect(elapsed_ms < 50 && !callback_fired,
           "execute returns immediately (off JS thread)");
    dispatch_semaphore_wait(slow_done, DISPATCH_TIME_FOREVER);

    NSDictionary* closed = WaitFor(^(void (^cb)(id)) {
      [module close:dbId callback:cb];
    });
    PrintEnvelope("close", closed);
    expect([closed[@"ok"] boolValue], "close ok");

    if (g_failures != 0) {
      std::fprintf(stderr, "%d iOS module check(s) failed\n", g_failures);
      return 1;
    }
    std::printf("all iOS NativePowerSyncModule RPC checks passed\n");
    return 0;
  }
}
