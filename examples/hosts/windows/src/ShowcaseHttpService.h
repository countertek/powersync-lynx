#pragma once

#include <atomic>
#include <memory>

#include "lynx_http_service.h"

class ShowcaseHttpService final : public lynx::pub::LynxHttpService {
 public:
  ShowcaseHttpService();
  ~ShowcaseHttpService() override;

  void Request(std::shared_ptr<lynx::pub::LynxHttpRequest> request,
               std::shared_ptr<lynx::pub::LynxHttpResponse> response) override;

 private:
  std::shared_ptr<std::atomic<bool>> alive_;
};
