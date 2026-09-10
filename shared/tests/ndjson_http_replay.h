#pragma once

/**
 * Loopback HTTP/1.1 replay of shared NDJSON fixtures.
 * Used by make test (POSIX client) and make test-ios (NativeSyncHttp).
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace ps_sync_fixtures {

struct ReplayConfig {
  std::string content_type = "application/x-ndjson";
  std::vector<std::string> chunks;
  bool hold_open = false;
  /** Accept then RST with no response line — pre-headers failure. */
  bool rst_before_headers = false;
  /** Write the first body chunk, then RST — error-then-end after onData. */
  bool rst_after_first_chunk = false;
  int gap_ms = 0;
};

class NdjsonReplayServer {
 public:
  NdjsonReplayServer() = default;
  NdjsonReplayServer(const NdjsonReplayServer&) = delete;
  NdjsonReplayServer& operator=(const NdjsonReplayServer&) = delete;

  ~NdjsonReplayServer() { stop(); }

  bool start(const ReplayConfig& config) {
    config_ = config;
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
      return false;
    }
    int yes = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(0);
    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
      ::close(listen_fd_);
      listen_fd_ = -1;
      return false;
    }
    socklen_t len = sizeof(addr);
    if (::getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
      ::close(listen_fd_);
      listen_fd_ = -1;
      return false;
    }
    port_ = ntohs(addr.sin_port);
    if (::listen(listen_fd_, 8) != 0) {
      ::close(listen_fd_);
      listen_fd_ = -1;
      return false;
    }
    stop_ = false;
    worker_ = std::thread([this] { loop(); });
    return true;
  }

  void stop() {
    stop_ = true;
    if (listen_fd_ >= 0) {
      int fd = listen_fd_;
      listen_fd_ = -1;
      ::shutdown(fd, SHUT_RDWR);
      ::close(fd);
    }
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  uint16_t port() const { return port_; }

  std::string url(const char* path = "/sync/stream") const {
    return "http://127.0.0.1:" + std::to_string(port_) + path;
  }

 private:
  static bool write_all(int fd, const char* data, size_t n) {
    size_t off = 0;
    while (off < n) {
      ssize_t w = ::send(fd, data + off, n - off, 0);
      if (w <= 0) {
        return false;
      }
      off += static_cast<size_t>(w);
    }
    return true;
  }

  static bool read_headers(int fd) {
    std::string buf;
    char c = 0;
    while (buf.find("\r\n\r\n") == std::string::npos && buf.size() < 65536) {
      ssize_t n = ::recv(fd, &c, 1, 0);
      if (n <= 0) {
        return false;
      }
      buf.push_back(c);
    }
    return buf.find("\r\n\r\n") != std::string::npos;
  }

  static void rst_close(int fd) {
    linger so {};
    so.l_onoff = 1;
    so.l_linger = 0;
    ::setsockopt(fd, SOL_SOCKET, SO_LINGER, &so, sizeof(so));
    ::close(fd);
  }

  void serve(int fd) {
    if (config_.rst_before_headers) {
      read_headers(fd);
      rst_close(fd);
      return;
    }
    if (!read_headers(fd)) {
      ::close(fd);
      return;
    }
    std::string body;
    for (const auto& chunk : config_.chunks) {
      body += chunk;
    }
    auto write_chunked = [&](const std::string& piece) {
      if (piece.empty()) {
        return true;
      }
      char hex[32];
      int n = std::snprintf(hex, sizeof(hex), "%zx\r\n", piece.size());
      if (n <= 0) {
        return false;
      }
      return write_all(fd, hex, static_cast<size_t>(n)) &&
             write_all(fd, piece.data(), piece.size()) && write_all(fd, "\r\n", 2);
    };
    if (config_.rst_after_first_chunk) {
      std::string header = "HTTP/1.1 200 OK\r\nContent-Type: " + config_.content_type +
                           "\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
      if (!write_all(fd, header.data(), header.size())) {
        ::close(fd);
        return;
      }
      if (!config_.chunks.empty()) {
        write_chunked(config_.chunks.front());
      }
      rst_close(fd);
      return;
    }
    std::string header;
    if (config_.hold_open) {
      header = "HTTP/1.1 200 OK\r\nContent-Type: " + config_.content_type +
               "\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
    } else {
      header = "HTTP/1.1 200 OK\r\nContent-Type: " + config_.content_type +
               "\r\nContent-Length: " + std::to_string(body.size()) +
               "\r\nConnection: close\r\n\r\n";
    }
    if (!write_all(fd, header.data(), header.size())) {
      ::close(fd);
      return;
    }
    if (config_.hold_open) {
      if (!config_.chunks.empty()) {
        write_chunked(config_.chunks.front());
      }
      for (int i = 0; i < 50 && !stop_; ++i) {
        ::usleep(100000);
      }
      write_all(fd, "0\r\n\r\n", 5);
    } else if (config_.gap_ms <= 0 || config_.chunks.size() <= 1) {
      if (!body.empty()) {
        write_all(fd, body.data(), body.size());
      }
    } else {
      for (size_t i = 0; i < config_.chunks.size(); ++i) {
        const auto& chunk = config_.chunks[i];
        if (!chunk.empty() && !write_all(fd, chunk.data(), chunk.size())) {
          ::close(fd);
          return;
        }
        if (i + 1 < config_.chunks.size() && config_.gap_ms > 0) {
          ::usleep(static_cast<useconds_t>(config_.gap_ms) * 1000);
        }
      }
    }
    ::shutdown(fd, SHUT_WR);
    ::close(fd);
  }

  void loop() {
    while (!stop_) {
      int fd = ::accept(listen_fd_ >= 0 ? listen_fd_ : -1, nullptr, nullptr);
      if (fd < 0) {
        if (stop_) {
          break;
        }
        if (errno == EINTR || errno == EAGAIN || errno == EBADF) {
          continue;
        }
        break;
      }
      serve(fd);
    }
  }

  ReplayConfig config_;
  int listen_fd_ = -1;
  uint16_t port_ = 0;
  std::atomic<bool> stop_{false};
  std::thread worker_;
};

inline bool http_get_body(const std::string& url, std::string* body_out, int* status_out) {
  const char* prefix = "http://127.0.0.1:";
  if (url.rfind(prefix, 0) != 0) {
    return false;
  }
  size_t slash = url.find('/', std::strlen(prefix));
  std::string port_s =
      url.substr(std::strlen(prefix), slash == std::string::npos ? std::string::npos
                                                                : slash - std::strlen(prefix));
  std::string path = slash == std::string::npos ? "/" : url.substr(slash);
  int port = std::atoi(port_s.c_str());
  int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    return false;
  }
  sockaddr_in addr {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    ::close(fd);
    return false;
  }
  std::string req = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  if (::send(fd, req.data(), req.size(), 0) < 0) {
    ::close(fd);
    return false;
  }
  std::string raw;
  char buf[1024];
  for (;;) {
    ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
    if (n < 0) {
      ::close(fd);
      return false;
    }
    if (n == 0) {
      break;
    }
    raw.append(buf, static_cast<size_t>(n));
  }
  ::close(fd);
  size_t sep = raw.find("\r\n\r\n");
  if (sep == std::string::npos) {
    return false;
  }
  if (status_out != nullptr) {
    *status_out = 0;
    size_t sp = raw.find(' ');
    if (sp != std::string::npos) {
      *status_out = std::atoi(raw.c_str() + sp + 1);
    }
  }
  if (body_out != nullptr) {
    *body_out = raw.substr(sep + 4);
  }
  return true;
}

}  // namespace ps_sync_fixtures
