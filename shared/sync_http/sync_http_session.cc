#include "sync_http_session.h"

#include <cstddef>
#include <utility>

namespace ps_sync_http {

int Route(bool is_sync_stream_url, bool has_event_sender) {
  return (is_sync_stream_url && has_event_sender) ? PS_SYNC_HTTP_ROUTE_STREAMING
                                                  : PS_SYNC_HTTP_ROUTE_IDLE;
}

size_t TrailingIncompleteUtf8Bytes(const uint8_t* bytes, size_t len) {
  if (bytes == nullptr || len == 0) {
    return 0;
  }
  size_t i = len - 1;
  size_t continuation = 0;
  for (;;) {
    if ((bytes[i] & 0xc0u) != 0x80u) {
      break;
    }
    continuation++;
    if (i == 0) {
      return len;
    }
    i--;
  }
  const uint8_t lead = bytes[i];
  size_t expected = 0;
  if ((lead & 0x80u) == 0) {
    expected = 0;
  } else if ((lead & 0xe0u) == 0xc0u) {
    expected = 1;
  } else if ((lead & 0xf0u) == 0xe0u) {
    expected = 2;
  } else if ((lead & 0xf8u) == 0xf0u) {
    expected = 3;
  } else {
    return 0;
  }
  if (continuation < expected) {
    return continuation + 1;
  }
  return 0;
}

std::string Utf8ChunkBuffer::Push(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) {
    return {};
  }
  carry_.insert(carry_.end(), data, data + len);
  const size_t hold = TrailingIncompleteUtf8Bytes(carry_.data(), carry_.size());
  const size_t complete = carry_.size() - hold;
  if (complete == 0) {
    return {};
  }
  std::string out(reinterpret_cast<const char*>(carry_.data()), complete);
  if (hold > 0) {
    carry_.erase(carry_.begin(),
                 carry_.begin() + static_cast<std::ptrdiff_t>(complete));
  } else {
    carry_.clear();
  }
  return out;
}

std::string Utf8ChunkBuffer::Flush() {
  if (carry_.empty()) {
    return {};
  }
  std::string out(reinterpret_cast<const char*>(carry_.data()), carry_.size());
  carry_.clear();
  return out;
}

void SyncHttpStreamSession::OnHeaders(int status,
                                      const std::string& status_text,
                                      const std::string& content_type,
                                      StreamSessionSink& sink) {
  std::lock_guard<std::recursive_mutex> emit_lock(emit_mutex_);
  bool should_emit = false;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (!aborted_ && !terminal_ && !headers_sent_) {
      headers_sent_ = true;
      should_emit = true;
    }
  }
  if (should_emit) {
    sink.OnHeaders(status, status_text, content_type);
  }
}

void SyncHttpStreamSession::OnBytes(const uint8_t* data, size_t len,
                                    StreamSessionSink& sink) {
  if (data == nullptr || len == 0) {
    return;
  }
  std::lock_guard<std::recursive_mutex> emit_lock(emit_mutex_);
  std::string chunk;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (!headers_sent_ || terminal_) {
      return;
    }
    chunk = utf8_buf_.Push(data, len);
  }
  if (!chunk.empty()) {
    sink.OnData(chunk);
  }
}

void SyncHttpStreamSession::OnEnd(StreamSessionSink& sink) {
  std::lock_guard<std::recursive_mutex> emit_lock(emit_mutex_);
  bool headers_sent = false;
  bool aborted = false;
  std::string tail;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (terminal_) {
      return;
    }
    terminal_ = true;
    headers_sent = headers_sent_;
    aborted = aborted_;
    if (headers_sent && !aborted) {
      tail = utf8_buf_.Flush();
    } else {
      utf8_buf_.Flush();
    }
  }
  if (!headers_sent) {
    sink.OnFail(aborted ? PS_SYNC_HTTP_ABORT_MESSAGE
                        : PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT);
    sink.OnDrop();
    return;
  }
  if (!tail.empty()) {
    sink.OnData(tail);
  }
  if (aborted) {
    sink.OnError(PS_SYNC_HTTP_ABORT_MESSAGE);
  }
  sink.OnEnd();
  sink.OnDrop();
}

void SyncHttpStreamSession::OnError(const std::string& message,
                                    StreamSessionSink& sink) {
  std::lock_guard<std::recursive_mutex> emit_lock(emit_mutex_);
  bool headers_sent = false;
  bool aborted = false;
  std::string tail;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (terminal_) {
      return;
    }
    terminal_ = true;
    headers_sent = headers_sent_;
    aborted = aborted_;
    if (headers_sent && !aborted) {
      tail = utf8_buf_.Flush();
    } else {
      utf8_buf_.Flush();
    }
  }
  const std::string effective =
      !message.empty()
          ? message
          : (aborted ? std::string(PS_SYNC_HTTP_ABORT_MESSAGE)
                     : std::string(PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT));
  if (!headers_sent) {
    sink.OnFail(effective);
    sink.OnDrop();
    return;
  }
  if (!tail.empty()) {
    sink.OnData(tail);
  }
  sink.OnError(effective);
  sink.OnEnd();
  sink.OnDrop();
}

void SyncHttpStreamSession::Abort(StreamSessionSink& sink) {
  bool cancel_io = false;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    aborted_ = true;
    cancel_io = !terminal_;
  }
  if (cancel_io) {
    sink.CancelIo();
  }
}

bool SyncHttpStreamSession::IsTerminal() const {
  std::lock_guard<std::mutex> lock(state_mutex_);
  return terminal_;
}

}  // namespace ps_sync_http
