#pragma once

#include <memory>

#include "lynx_generic_resource_fetcher.h"

class ShowcaseResourceFetcher final : public lynx::pub::LynxGenericResourceFetcher {
 public:
  ShowcaseResourceFetcher();
  ~ShowcaseResourceFetcher() override;

  void FetchResource(
      std::shared_ptr<lynx::pub::resource::LynxResourceRequest> request,
      std::shared_ptr<lynx::pub::resource::LynxResourceResponse> response) override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
