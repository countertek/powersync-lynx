#import "ShowcaseHttpService.h"

#import <Foundation/Foundation.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

struct ShowcaseHttpService::Impl {
  NSURLSession* session = nil;
};

ShowcaseHttpService::ShowcaseHttpService() : impl_(std::make_unique<Impl>()) {
  NSURLSessionConfiguration* config =
      [NSURLSessionConfiguration defaultSessionConfiguration];
  config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  config.timeoutIntervalForRequest = 60.0;
  impl_->session = [NSURLSession sessionWithConfiguration:config];
}

ShowcaseHttpService::~ShowcaseHttpService() {
  if (impl_ && impl_->session != nil) {
    [impl_->session invalidateAndCancel];
    impl_->session = nil;
  }
}

void ShowcaseHttpService::Request(
    std::shared_ptr<lynx::pub::LynxHttpRequest> request,
    std::shared_ptr<lynx::pub::LynxHttpResponse> response) {
  if (!request || !response) {
    return;
  }

  const std::string urlCopy = request->GetUrl();
  const std::string methodCopy =
      request->GetMethod().empty() ? "GET" : request->GetMethod();
  NSString* nsUrlStr = [NSString stringWithUTF8String:urlCopy.c_str()];
  NSURL* nsUrl = nsUrlStr ? [NSURL URLWithString:nsUrlStr] : nil;
  if (nsUrl == nil) {
    std::fprintf(stderr, "[ShowcaseHttpService] invalid URL: %s\n", urlCopy.c_str());
    response->SetStatusCode(-1);
    response->SetStatusText("Invalid URL");
    response->Complete();
    return;
  }

  NSMutableURLRequest* nsReq = [NSMutableURLRequest requestWithURL:nsUrl];
  nsReq.HTTPMethod = [NSString stringWithUTF8String:methodCopy.c_str()];
  for (const auto& kv : request->GetHeaders()) {
    NSString* key = [NSString stringWithUTF8String:kv.first.c_str()];
    NSString* value = [NSString stringWithUTF8String:kv.second.c_str()];
    if (key != nil && value != nil) {
      [nsReq setValue:value forHTTPHeaderField:key];
    }
  }

  const auto& body = request->GetBody();
  if (!body.empty()) {
    nsReq.HTTPBody = [NSData dataWithBytes:body.data() length:body.size()];
  }

  std::fprintf(stderr, "[ShowcaseHttpService] -> %s %s (%zu body bytes)\n",
               methodCopy.c_str(), urlCopy.c_str(), body.size());
  std::fflush(stderr);

  // NOTE: Lynx 4.2.0 Desktop C++ LynxHttpService / lynx_http_service_capi.h
  // exposes only a single buffered SetBody() + Complete() callback and no
  // request cancellation hook. Long-lived streaming responses (such as
  // PowerSync's /sync/stream NDJSON) cannot deliver incremental chunks before
  // connection close through this API.
  NSURLSessionDataTask* task = [impl_->session
      dataTaskWithRequest:nsReq
        completionHandler:^(NSData* data, NSURLResponse* urlResponse, NSError* error) {
          if (error != nil) {
            const char* errText = error.localizedDescription.UTF8String
                                      ? error.localizedDescription.UTF8String
                                      : "NSURLSession request failed";
            std::fprintf(stderr, "[ShowcaseHttpService] <- %s %s ERROR (%ld): %s\n",
                         methodCopy.c_str(), urlCopy.c_str(),
                         static_cast<long>(error.code), errText);
            std::fflush(stderr);
            response->SetStatusCode(-1);
            response->SetStatusText(errText);
            response->Complete();
            return;
          }

          int statusCode = 200;
          if ([urlResponse isKindOfClass:[NSHTTPURLResponse class]]) {
            NSHTTPURLResponse* httpResp = static_cast<NSHTTPURLResponse*>(urlResponse);
            statusCode = static_cast<int>(httpResp.statusCode);
            response->SetStatusCode(statusCode);
            NSString* reason = [NSHTTPURLResponse localizedStringForStatusCode:statusCode];
            response->SetStatusText(reason ? reason.UTF8String : "");
            [httpResp.allHeaderFields
                enumerateKeysAndObjectsUsingBlock:^(id keyObj, id valObj, BOOL*) {
                  NSString* key = [keyObj description];
                  NSString* val = [valObj description];
                  if (key.UTF8String != nullptr && val.UTF8String != nullptr) {
                    response->AddHeader(key.UTF8String, val.UTF8String);
                  }
                }];
          } else {
            response->SetStatusCode(statusCode);
            response->SetStatusText("OK");
          }

          size_t bodyLen = data ? static_cast<size_t>(data.length) : 0;
          if (bodyLen > 0) {
            auto* buffer = new uint8_t[bodyLen];
            std::memcpy(buffer, data.bytes, bodyLen);
            response->SetBody(
                buffer, bodyLen,
                [](uint8_t* ptr, size_t, void*) { delete[] ptr; }, nullptr);
          }

          std::fprintf(stderr, "[ShowcaseHttpService] <- %s %s HTTP %d (%zu bytes)\n",
                       methodCopy.c_str(), urlCopy.c_str(), statusCode, bodyLen);
          std::fflush(stderr);
          response->Complete();
        }];
  [task resume];
}
