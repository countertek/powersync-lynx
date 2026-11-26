#pragma once

#include <string>

struct HostConfig {
  std::string device;
  std::string demo_api_url;
  std::string powersync_url;
  std::string bundle_path;
  std::string exit_file;
  bool smoke_test = false;
  bool headless = false;
  bool e2e = false;
  double smoke_seconds = 6.0;

  static HostConfig FromProcess();
  std::string GlobalPropsJson() const;
};
