#pragma once

#include <memory>

#include "lynx_http_service.h"

class ShowcaseHttpService final : public lynx::pub::LynxHttpService {
 public:
  ShowcaseHttpService();
  ~ShowcaseHttpService() override;

  void Request(std::shared_ptr<lynx::pub::LynxHttpRequest> request,
               std::shared_ptr<lynx::pub::LynxHttpResponse> response) override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
