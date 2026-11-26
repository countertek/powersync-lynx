#pragma once

#include <memory>

#include "lynx_generic_resource_fetcher.h"

class ShowcaseResourceFetcher final
    : public lynx::pub::LynxGenericResourceFetcher {
 public:
  ShowcaseResourceFetcher() = default;
  ~ShowcaseResourceFetcher() override = default;

  void FetchResource(
      std::shared_ptr<lynx::pub::resource::LynxResourceRequest> request,
      std::shared_ptr<lynx::pub::resource::LynxResourceResponse> response)
      override;
};
