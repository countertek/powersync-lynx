#import "ShowcaseResourceFetcher.h"

#import <Foundation/Foundation.h>

#include <cstring>
#include <fstream>
#include <string>
#include <vector>

struct ShowcaseResourceFetcher::Impl {
  NSURLSession* session = nil;
};

ShowcaseResourceFetcher::ShowcaseResourceFetcher()
    : impl_(std::make_unique<Impl>()) {
  NSURLSessionConfiguration* config =
      [NSURLSessionConfiguration defaultSessionConfiguration];
  impl_->session = [NSURLSession sessionWithConfiguration:config];
}

ShowcaseResourceFetcher::~ShowcaseResourceFetcher() {
  if (impl_ && impl_->session != nil) {
    [impl_->session invalidateAndCancel];
    impl_->session = nil;
  }
}

void ShowcaseResourceFetcher::FetchResource(
    std::shared_ptr<lynx::pub::resource::LynxResourceRequest> request,
    std::shared_ptr<lynx::pub::resource::LynxResourceResponse> response) {
  if (!request || !response) {
    return;
  }
  const char* rawUrl = request->GetUrl();
  std::string url = rawUrl ? rawUrl : "";

  if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) {
    NSURL* nsUrl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
    if (nsUrl == nil) {
      response->SetCode(-1);
      response->SetErrorMessage("Invalid resource URL");
      response->Complete();
      return;
    }
    NSURLSessionDataTask* task = [impl_->session
          dataTaskWithURL:nsUrl
        completionHandler:^(NSData* data, NSURLResponse*, NSError* error) {
          if (error != nil) {
            response->SetCode(-1);
            response->SetErrorMessage(
                error.localizedDescription.UTF8String
                    ? error.localizedDescription.UTF8String
                    : "Resource download failed");
            response->Complete();
            return;
          }
          response->SetCode(0);
          if (data && data.length > 0) {
            size_t len = static_cast<size_t>(data.length);
            auto* buf = new uint8_t[len];
            std::memcpy(buf, data.bytes, len);
            response->SetData(
                buf, len, [](uint8_t* ptr, size_t, void*) { delete[] ptr; },
                nullptr);
          }
          response->Complete();
        }];
    [task resume];
    return;
  }

  std::string path = url;
  if (path.rfind("file://", 0) == 0) {
    path = path.substr(7);
  }
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file) {
    response->SetCode(-1);
    response->SetErrorMessage("Local resource not found");
    response->Complete();
    return;
  }
  std::streamsize size = file.tellg();
  file.seekg(0, std::ios::beg);
  if (size > 0) {
    auto* buf = new uint8_t[static_cast<size_t>(size)];
    if (!file.read(reinterpret_cast<char*>(buf), size)) {
      delete[] buf;
      response->SetCode(-1);
      response->SetErrorMessage("Failed reading local resource");
      response->Complete();
      return;
    }
    response->SetCode(0);
    response->SetData(
        buf, static_cast<size_t>(size),
        [](uint8_t* ptr, size_t, void*) { delete[] ptr; }, nullptr);
  } else {
    response->SetCode(0);
  }
  response->Complete();
}
