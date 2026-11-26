#pragma once

#include <string>

struct HostConfig {
  std::string device;
  std::string demo_api_url;
  std::string powersync_url;
  std::string bundle_path;
  bool smoke_test = false;
  bool headless = false;
  double smoke_seconds = 6.0;

  static HostConfig FromProcess();
  std::string GlobalPropsJson() const;
};

std::string ExecutableDirectoryUtf8();
