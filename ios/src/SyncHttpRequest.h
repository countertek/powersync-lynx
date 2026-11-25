#pragma once

#import <Foundation/Foundation.h>

#ifdef __cplusplus
#include <string>

static inline std::string Utf8FromNSString(NSString *_Nullable value) {
  if (value == nil) {
    return {};
  }
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil || data.length == 0) {
    return {};
  }
  const auto *bytes = static_cast<const char *>(data.bytes);
  return std::string(bytes, bytes + data.length);
}
#endif

static inline NSMutableURLRequest *_Nullable BuildSyncHttpURLRequest(
    NSDictionary *_Nullable request,
    NSTimeInterval timeoutInterval,
    NSString *__autoreleasing _Nullable *_Nullable errorOut) {
  id urlValue = request[@"url"];
  if (![urlValue isKindOfClass:[NSString class]] || [(NSString *)urlValue length] == 0) {
    if (errorOut != NULL) {
      *errorOut = @"httpFetch requires string url";
    }
    return nil;
  }
  NSURL *url = [NSURL URLWithString:(NSString *)urlValue];
  if (url == nil) {
    if (errorOut != NULL) {
      *errorOut = @"httpFetch invalid url";
    }
    return nil;
  }

  NSString *method = @"GET";
  id methodValue = request[@"method"];
  if ([methodValue isKindOfClass:[NSString class]] && [(NSString *)methodValue length] > 0) {
    method = [(NSString *)methodValue uppercaseString];
  }

  NSDictionary *headers = nil;
  id headersValue = request[@"headers"];
  if ([headersValue isKindOfClass:[NSDictionary class]]) {
    headers = (NSDictionary *)headersValue;
  }

  NSData *bodyData = nil;
  id bodyValue = request[@"body"];
  if ([bodyValue isKindOfClass:[NSString class]]) {
    bodyData = [(NSString *)bodyValue dataUsingEncoding:NSUTF8StringEncoding];
  }

  NSMutableURLRequest *urlRequest = [NSMutableURLRequest requestWithURL:url];
  urlRequest.HTTPMethod = method;
  urlRequest.timeoutInterval = timeoutInterval;
  urlRequest.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  if (headers != nil) {
    for (id key in headers) {
      if (![key isKindOfClass:[NSString class]]) {
        continue;
      }
      id value = headers[key];
      NSString *headerValue =
          [value isKindOfClass:[NSString class]] ? (NSString *)value : [value description];
      [urlRequest setValue:headerValue forHTTPHeaderField:(NSString *)key];
    }
  }
  if (bodyData != nil && bodyData.length > 0) {
    urlRequest.HTTPBody = bodyData;
  }
  return urlRequest;
}
