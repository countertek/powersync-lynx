#pragma once

/**
 * Loopback HTTP/1.1 replay of shared NDJSON fixtures.
 * Used by make test (POSIX client) and make test-ios (NativeSyncHttp).
 */

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace ps_sync_fixtures {

namespace replay_net {
#if defined(_WIN32)
using SocketHandle = SOCKET;
constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;

inline void ensure_init() {
  static const int initialized = []() {
    WSADATA data {};
    WSAStartup(MAKEWORD(2, 2), &data);
    return 1;
  }();
  (void)initialized;
}

inline void close_socket(SocketHandle fd) {
  if (fd != kInvalidSocket) {
    ::closesocket(fd);
  }
}

inline void shutdown_both(SocketHandle fd) {
  if (fd != kInvalidSocket) {
    ::shutdown(fd, SD_BOTH);
  }
}

inline void shutdown_write(SocketHandle fd) {
  if (fd != kInvalidSocket) {
    ::shutdown(fd, SD_SEND);
  }
}

inline void sleep_ms(int ms) {
  if (ms > 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
  }
}
#else
using SocketHandle = int;
constexpr SocketHandle kInvalidSocket = -1;

inline void ensure_init() {}

inline void close_socket(SocketHandle fd) {
  if (fd >= 0) {
    ::close(fd);
  }
}

inline void shutdown_both(SocketHandle fd) {
  if (fd >= 0) {
    ::shutdown(fd, SHUT_RDWR);
  }
}

inline void shutdown_write(SocketHandle fd) {
  if (fd >= 0) {
    ::shutdown(fd, SHUT_WR);
  }
}

inline void sleep_ms(int ms) {
  if (ms > 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
  }
}
#endif
}  // namespace replay_net

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
    replay_net::ensure_init();
    config_ = config;
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ == replay_net::kInvalidSocket) {
      return false;
    }
    int yes = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR,
                 reinterpret_cast<const char*>(&yes), sizeof(yes));
    sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(0);
    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
      replay_net::close_socket(listen_fd_);
      listen_fd_ = replay_net::kInvalidSocket;
      return false;
    }
    socklen_t len = sizeof(addr);
    if (::getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
      replay_net::close_socket(listen_fd_);
      listen_fd_ = replay_net::kInvalidSocket;
      return false;
    }
    port_ = ntohs(addr.sin_port);
    if (::listen(listen_fd_, 8) != 0) {
      replay_net::close_socket(listen_fd_);
      listen_fd_ = replay_net::kInvalidSocket;
      return false;
    }
    stop_ = false;
    worker_ = std::thread([this] { loop(); });
    return true;
  }

  void stop() {
    stop_ = true;
    if (listen_fd_ != replay_net::kInvalidSocket) {
      replay_net::SocketHandle fd = listen_fd_;
      listen_fd_ = replay_net::kInvalidSocket;
      replay_net::shutdown_both(fd);
      replay_net::close_socket(fd);
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
  static bool write_all(replay_net::SocketHandle fd, const char* data, size_t n) {
    size_t off = 0;
    while (off < n) {
      auto w = ::send(fd, data + off, static_cast<int>(n - off), 0);
      if (w <= 0) {
        return false;
      }
      off += static_cast<size_t>(w);
    }
    return true;
  }

  static bool read_headers(replay_net::SocketHandle fd) {
    std::string buf;
    char c = 0;
    while (buf.find("\r\n\r\n") == std::string::npos && buf.size() < 65536) {
      auto n = ::recv(fd, &c, 1, 0);
      if (n <= 0) {
        return false;
      }
      buf.push_back(c);
    }
    return buf.find("\r\n\r\n") != std::string::npos;
  }

  static void rst_close(replay_net::SocketHandle fd) {
    linger so {};
    so.l_onoff = 1;
    so.l_linger = 0;
    ::setsockopt(fd, SOL_SOCKET, SO_LINGER,
                 reinterpret_cast<const char*>(&so), sizeof(so));
    replay_net::close_socket(fd);
  }

  static void set_tcp_nodelay(replay_net::SocketHandle fd) {
    int yes = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY,
                 reinterpret_cast<const char*>(&yes), sizeof(yes));
  }

  /**
   * Darwin SO_LINGER/RST discards unacked (and often still-unread) send data, so
   * NSURLSession never sees headers + the first chunk. Wait until the send queue
   * is empty, then give the peer a beat to read before RST.
   */
  static void wait_send_drained(replay_net::SocketHandle fd) {
    for (int i = 0; i < 200; ++i) {
      int outstanding = 0;
#if defined(__APPLE__)
      socklen_t len = sizeof(outstanding);
      if (::getsockopt(fd, SOL_SOCKET, SO_NWRITE, &outstanding, &len) != 0) {
        break;
      }
#elif !defined(_WIN32) && defined(TIOCOUTQ)
      if (::ioctl(fd, TIOCOUTQ, &outstanding) != 0) {
        break;
      }
#else
      (void)fd;
      break;
#endif
      if (outstanding == 0) {
        break;
      }
      replay_net::sleep_ms(5);
    }
    replay_net::sleep_ms(100);
  }

  static void rst_after_delivered(replay_net::SocketHandle fd) {
    wait_send_drained(fd);
    rst_close(fd);
  }

  void serve(replay_net::SocketHandle fd) {
    set_tcp_nodelay(fd);
    if (config_.rst_before_headers) {
      read_headers(fd);
      rst_close(fd);
      return;
    }
    if (!read_headers(fd)) {
      replay_net::close_socket(fd);
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
        replay_net::close_socket(fd);
        return;
      }
      if (!config_.chunks.empty()) {
        write_chunked(config_.chunks.front());
      }
      rst_after_delivered(fd);
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
      replay_net::close_socket(fd);
      return;
    }
    if (config_.hold_open) {
      if (!config_.chunks.empty()) {
        write_chunked(config_.chunks.front());
      }
      for (int i = 0; i < 50 && !stop_; ++i) {
        replay_net::sleep_ms(100);
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
          replay_net::close_socket(fd);
          return;
        }
        if (i + 1 < config_.chunks.size() && config_.gap_ms > 0) {
          replay_net::sleep_ms(config_.gap_ms);
        }
      }
    }
    replay_net::shutdown_write(fd);
    replay_net::close_socket(fd);
  }

  void loop() {
    while (!stop_) {
      replay_net::SocketHandle fd =
          ::accept(listen_fd_, nullptr, nullptr);
      if (fd == replay_net::kInvalidSocket) {
        if (stop_) {
          break;
        }
#if defined(_WIN32)
        const int err = WSAGetLastError();
        if (err == WSAEINTR || err == WSAEWOULDBLOCK) {
          continue;
        }
#else
        if (errno == EINTR || errno == EAGAIN || errno == EBADF) {
          continue;
        }
#endif
        break;
      }
      serve(fd);
    }
  }

  ReplayConfig config_;
  replay_net::SocketHandle listen_fd_ = replay_net::kInvalidSocket;
  uint16_t port_ = 0;
  std::atomic<bool> stop_{false};
  std::thread worker_;
};

/**
 * Connect, GET, read until FIN or RST. RST is success if any bytes arrived
 * (`saw_rst_out`). Returns false if the socket fails before any payload.
 */
inline bool http_read_until_close(const std::string& url, std::string* raw_out, bool* saw_rst_out) {
  replay_net::ensure_init();
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
  replay_net::SocketHandle fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd == replay_net::kInvalidSocket) {
    return false;
  }
  sockaddr_in addr {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    replay_net::close_socket(fd);
    return false;
  }
  std::string req = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  if (::send(fd, req.data(), static_cast<int>(req.size()), 0) < 0) {
    replay_net::close_socket(fd);
    return false;
  }
  std::string raw;
  bool saw_rst = false;
  char buf[1024];
  for (;;) {
    auto n = ::recv(fd, buf, static_cast<int>(sizeof(buf)), 0);
    if (n < 0) {
#if defined(_WIN32)
      const int err = WSAGetLastError();
      if (err == WSAEINTR) {
        continue;
      }
      if ((err == WSAECONNRESET || err == WSAECONNABORTED) && !raw.empty()) {
        saw_rst = true;
        break;
      }
#else
      if (errno == EINTR) {
        continue;
      }
      if ((errno == ECONNRESET || errno == EPIPE) && !raw.empty()) {
        saw_rst = true;
        break;
      }
#endif
      replay_net::close_socket(fd);
      return false;
    }
    if (n == 0) {
      break;
    }
    raw.append(buf, static_cast<size_t>(n));
  }
  replay_net::close_socket(fd);
  if (raw_out != nullptr) {
    *raw_out = raw;
  }
  if (saw_rst_out != nullptr) {
    *saw_rst_out = saw_rst;
  }
  return !raw.empty();
}

inline bool http_get_body(const std::string& url, std::string* body_out, int* status_out) {
  std::string raw;
  if (!http_read_until_close(url, &raw, nullptr)) {
    return false;
  }
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
