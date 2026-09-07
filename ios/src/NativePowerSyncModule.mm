#import "NativePowerSyncModule.h"

#include "ps_sql.h"

#include <cmath>
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

id CellToId(const Cell& cell) {
  switch (cell.kind) {
    case CellKind::kNull:
      return [NSNull null];
    case CellKind::kInteger:
      if (cell.integer_as_bigint) {
        return [NSString stringWithFormat:@"%lld", (long long)cell.i];
      }
      return @(cell.i);
    case CellKind::kFloat:
      return @(cell.f);
    case CellKind::kText:
      return [NSString stringWithUTF8String:cell.text.c_str()];
    case CellKind::kBlob:
      return [NSData dataWithBytes:cell.blob.data() length:cell.blob.size()];
  }
  return [NSNull null];
}

NSDictionary* EnvelopeToDict(const Envelope& envelope) {
  NSMutableDictionary* dict = [NSMutableDictionary dictionary];
  dict[@"ok"] = @(envelope.ok);
  if (!envelope.ok) {
    dict[@"message"] = [NSString stringWithUTF8String:envelope.message.c_str()];
    if (envelope.code.has_value()) {
      dict[@"code"] = @(*envelope.code);
    }
    return dict;
  }
  if (!envelope.db_id.empty()) {
    dict[@"dbId"] = [NSString stringWithUTF8String:envelope.db_id.c_str()];
  }
  dict[@"insertId"] = @(envelope.insert_id);
  dict[@"rowsAffected"] = @(envelope.rows_affected);
  NSMutableArray* names = [NSMutableArray arrayWithCapacity:envelope.column_names.size()];
  for (const auto& name : envelope.column_names) {
    [names addObject:[NSString stringWithUTF8String:name.c_str()]];
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
  if ([value isKindOfClass:[NSString class]]) {
    out->kind = CellKind::kText;
    out->text = [((NSString*)value) UTF8String];
    return true;
  }
  if ([value isKindOfClass:[NSData class]]) {
    NSData* data = (NSData*)value;
    out->kind = CellKind::kBlob;
    const auto* bytes = static_cast<const std::uint8_t*>(data.bytes);
    out->blob.assign(bytes, bytes + data.length);
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
  NSDictionary* dict = EnvelopeToDict(envelope);
  callback(dict);
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
  open_options.db_filename = [filename UTF8String];
  id location = options[@"dbLocation"];
  if ([location isKindOfClass:[NSString class]]) {
    BOOL isDir = NO;
    BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:location
                                                       isDirectory:&isDir];
    if (!exists || !isDir) {
      Finish(cb, ps_sql::fail("dbLocation does not exist"));
      return;
    }
    open_options.db_location = [location UTF8String];
  } else {
    NSArray* paths = NSSearchPathForDirectoriesInDomains(
        NSDocumentDirectory, NSUserDomainMask, YES);
    if (paths.count > 0) {
      open_options.db_location = [paths[0] UTF8String];
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
  SharedEngine().close([dbId UTF8String],
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
    Finish(cb, ps_sql::fail([error UTF8String]));
    return;
  }
  SharedEngine().execute([dbId UTF8String], [sql UTF8String], std::move(binds),
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
        Finish(cb, ps_sql::fail([error UTF8String]));
        return;
      }
      rows.push_back(std::move(binds));
    }
  }
  SharedEngine().execute_batch(
      [dbId UTF8String], [sql UTF8String], std::move(rows),
      [cb](Envelope env) { Finish(cb, std::move(env)); });
}

@end
