#import "NativePowerSyncModule.h"

#include "ps_sql.h"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

using ps_sql::BindValue;
using ps_sql::Cell;
using ps_sql::CellKind;
using ps_sql::Engine;
using ps_sql::EngineConfig;
using ps_sql::Envelope;
using ps_sql::OpenOptions;

namespace {

Engine& SharedEngine() {
  static Engine* engine = [] {
    EngineConfig config;
    config.core_load = ps_sql::CoreLoad::kAutoExtension;
    config.core_path.clear();
    return new Engine(config);
  }();
  return *engine;
}

NSString* NSStringFromUtf8(const std::string& text) {
  if (text.empty()) {
    return @"";
  }
  NSString* result = [[NSString alloc] initWithBytes:text.data()
                                              length:text.size()
                                            encoding:NSUTF8StringEncoding];
  return result != nil ? result : @"";
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

id CellToId(const Cell& cell) {
  switch (cell.kind) {
    case CellKind::kNull:
      return [NSNull null];
    case CellKind::kInteger:
      if (cell.integer_as_bigint) {
        return @{
          @"__psBig" : @YES,
          @"v" : [NSString stringWithFormat:@"%lld", (long long)cell.i]
        };
      }
      return @(cell.i);
    case CellKind::kFloat:
      return @(cell.f);
    case CellKind::kText:
      return NSStringFromUtf8(cell.text);
    case CellKind::kBlob:
      return [NSData dataWithBytes:cell.blob.data() length:cell.blob.size()];
  }
  return [NSNull null];
}

NSDictionary* EnvelopeToDict(const Envelope& envelope) {
  NSMutableDictionary* dict = [NSMutableDictionary dictionary];
  dict[@"ok"] = @(envelope.ok);
  if (!envelope.ok) {
    dict[@"message"] = NSStringFromUtf8(envelope.message);
    if (envelope.code.has_value()) {
      dict[@"code"] = @(*envelope.code);
    }
    return dict;
  }
  if (!envelope.db_id.empty()) {
    dict[@"dbId"] = NSStringFromUtf8(envelope.db_id);
  }
  dict[@"insertId"] = @(envelope.insert_id);
  dict[@"rowsAffected"] = @(envelope.rows_affected);
  NSMutableArray* names = [NSMutableArray arrayWithCapacity:envelope.column_names.size()];
  for (const auto& name : envelope.column_names) {
    [names addObject:NSStringFromUtf8(name)];
  }
  dict[@"columnNames"] = names;
  NSMutableArray* rows = [NSMutableArray arrayWithCapacity:envelope.raw_rows.size()];
  for (const auto& row : envelope.raw_rows) {
    NSMutableArray* jsRow = [NSMutableArray arrayWithCapacity:row.size()];
    for (const auto& cell : row) {
      [jsRow addObject:CellToId(cell)];
    }
    [rows addObject:jsRow];
  }
  dict[@"rawRows"] = rows;
  return dict;
}

bool ParseTaggedBigInt(NSDictionary* dict, BindValue* out, NSString** error) {
  id tag = dict[@"__psBig"];
  if (![tag respondsToSelector:@selector(boolValue)] || ![tag boolValue]) {
    *error = @"unsupported bind value";
    return false;
  }
  id encoded = dict[@"v"];
  if (![encoded isKindOfClass:[NSString class]]) {
    *error = @"invalid tagged bigint";
    return false;
  }
  const std::string digits = Utf8FromNSString((NSString*)encoded);
  if (digits.empty()) {
    *error = @"invalid tagged bigint";
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const long long parsed = std::strtoll(digits.c_str(), &end, 10);
  if (end == digits.c_str() || *end != '\0' || errno == ERANGE) {
    *error = @"invalid tagged bigint";
    return false;
  }
  out->kind = CellKind::kInteger;
  out->i = parsed;
  return true;
}

bool ParseBind(id value, BindValue* out, NSString** error) {
  if (value == nil || value == [NSNull null]) {
    out->kind = CellKind::kNull;
    return true;
  }
  if ([value isKindOfClass:[NSNumber class]]) {
    NSNumber* number = (NSNumber*)value;
    const char* type = [number objCType];
    if (strcmp(type, @encode(double)) == 0 || strcmp(type, @encode(float)) == 0) {
      double d = [number doubleValue];
      if (d == rint(d) && d <= 9007199254740991.0 && d >= -9007199254740991.0) {
        out->kind = CellKind::kInteger;
        out->i = [number longLongValue];
      } else {
        out->kind = CellKind::kFloat;
        out->f = d;
      }
    } else {
      out->kind = CellKind::kInteger;
      out->i = [number longLongValue];
    }
    return true;
  }
  if ([value isKindOfClass:[NSDictionary class]]) {
    return ParseTaggedBigInt((NSDictionary*)value, out, error);
  }
  if ([value isKindOfClass:[NSString class]]) {
    // Lynx maps JS string and JS BigInt to NSString. Bind NSString as TEXT so
    // spec string BindValue (snowflake/id) matches Android ReadableType.String
    // and N-API IsString. Do not treat canonical decimals as INTEGER. Bigint
    // identity uses the tagged { __psBig, v } dictionary instead.
    out->kind = CellKind::kText;
    out->text = Utf8FromNSString((NSString*)value);
    return true;
  }
  if ([value isKindOfClass:[NSData class]]) {
    NSData* data = (NSData*)value;
    out->kind = CellKind::kBlob;
    const auto* bytes = static_cast<const std::uint8_t*>(data.bytes);
    if (bytes != nullptr && data.length > 0) {
      out->blob.assign(bytes, bytes + data.length);
    }
    return true;
  }
  *error = @"unsupported bind value";
  return false;
}

bool ParseParams(NSArray* params, std::vector<BindValue>* out, NSString** error) {
  out->clear();
  if (params == nil) {
    return true;
  }
  for (id value in params) {
    BindValue bind;
    if (!ParseBind(value, &bind, error)) {
      return false;
    }
    out->push_back(std::move(bind));
  }
  return true;
}

void Finish(void (^callback)(id), Envelope envelope) {
  if (callback == nil) {
    return;
  }
  // Lynx NativeModule Invocation: "any thread may invoke and execute
  // callback-related logic." Do not hop to the main queue.
  @autoreleasepool {
    NSDictionary* dict = EnvelopeToDict(envelope);
    callback(dict);
  }
}

}  // namespace

@implementation NativePowerSyncModule

+ (NSString*)name {
  return @"NativePowerSyncModule";
}

+ (NSDictionary<NSString*, NSString*>*)methodLookup {
  return @{
    @"open" : NSStringFromSelector(@selector(open:callback:)),
    @"close" : NSStringFromSelector(@selector(close:callback:)),
    @"execute" : NSStringFromSelector(@selector(execute:sql:params:callback:)),
    @"executeBatch" : NSStringFromSelector(@selector(executeBatch:sql:params:callback:)),
  };
}

- (void)open:(NSDictionary*)options callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  OpenOptions open_options;
  id filename = options[@"dbFilename"];
  if (![filename isKindOfClass:[NSString class]] ||
      [(NSString*)filename length] == 0) {
    Finish(cb, ps_sql::fail("dbFilename is required"));
    return;
  }
  open_options.db_filename = Utf8FromNSString((NSString*)filename);
  id location = options[@"dbLocation"];
  if ([location isKindOfClass:[NSString class]]) {
    BOOL isDir = NO;
    BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:location
                                                       isDirectory:&isDir];
    if (!exists || !isDir) {
      Finish(cb, ps_sql::fail("dbLocation does not exist"));
      return;
    }
    open_options.db_location = Utf8FromNSString((NSString*)location);
  } else {
    NSArray* paths = NSSearchPathForDirectoriesInDomains(
        NSDocumentDirectory, NSUserDomainMask, YES);
    if (paths.count > 0) {
      open_options.db_location = Utf8FromNSString(paths[0]);
    }
  }
  id readOnly = options[@"readOnly"];
  if ([readOnly isKindOfClass:[NSNumber class]]) {
    open_options.read_only = [readOnly boolValue];
  }
  SharedEngine().open(std::move(open_options),
                      [cb](Envelope env) { Finish(cb, std::move(env)); });
}

- (void)close:(NSString*)dbId callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  if (dbId == nil) {
    Finish(cb, ps_sql::fail("close expects a dbId string"));
    return;
  }
  SharedEngine().close(Utf8FromNSString(dbId),
                       [cb](Envelope env) { Finish(cb, std::move(env)); });
}

- (void)execute:(NSString*)dbId
            sql:(NSString*)sql
         params:(NSArray*)params
       callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  if (dbId == nil || sql == nil) {
    Finish(cb, ps_sql::fail("execute expects dbId, sql, params"));
    return;
  }
  std::vector<BindValue> binds;
  NSString* error = nil;
  if (!ParseParams(params, &binds, &error)) {
    Finish(cb, ps_sql::fail(Utf8FromNSString(error)));
    return;
  }
  SharedEngine().execute(Utf8FromNSString(dbId), Utf8FromNSString(sql), std::move(binds),
                         [cb](Envelope env) { Finish(cb, std::move(env)); });
}

- (void)executeBatch:(NSString*)dbId
                 sql:(NSString*)sql
              params:(NSArray*)params
            callback:(void (^)(id))callback {
  void (^cb)(id) = [callback copy];
  if (dbId == nil || sql == nil) {
    Finish(cb, ps_sql::fail("executeBatch expects dbId, sql, params"));
    return;
  }
  std::vector<std::vector<BindValue>> rows;
  NSString* error = nil;
  if (params != nil) {
    for (id row in params) {
      if (![row isKindOfClass:[NSArray class]]) {
        Finish(cb, ps_sql::fail("params must be an array of parameter rows"));
        return;
      }
      std::vector<BindValue> binds;
      if (!ParseParams((NSArray*)row, &binds, &error)) {
        Finish(cb, ps_sql::fail(Utf8FromNSString(error)));
        return;
      }
      rows.push_back(std::move(binds));
    }
  }
  SharedEngine().execute_batch(
      Utf8FromNSString(dbId), Utf8FromNSString(sql), std::move(rows),
      [cb](Envelope env) { Finish(cb, std::move(env)); });
}

@end
