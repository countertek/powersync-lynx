#include "ShowcaseResourceFetcher.h"

#include <windows.h>

#include <cstring>
#include <string>
#include <vector>

#include "win_utf8.h"

namespace {

bool ReadLocalFileUtf8(const std::string& path, std::vector<uint8_t>* out) {
  std::wstring wide = ps_sql::Utf8ToWide(path);
  if (wide.empty()) {
    return false;
  }
  HANDLE file = CreateFileW(wide.c_str(), GENERIC_READ, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return false;
  }
  LARGE_INTEGER file_size{};
  if (!GetFileSizeEx(file, &file_size) || file_size.QuadPart < 0) {
    CloseHandle(file);
    return false;
  }
  out->resize(static_cast<size_t>(file_size.QuadPart));
  size_t total_read = 0;
  while (total_read < out->size()) {
    DWORD chunk = static_cast<DWORD>(
        (out->size() - total_read) > 0x1000000 ? 0x1000000
                                               : (out->size() - total_read));
    DWORD bytes_read = 0;
    if (!ReadFile(file, out->data() + total_read, chunk, &bytes_read, nullptr) ||
        bytes_read == 0) {
      CloseHandle(file);
      return false;
    }
    total_read += bytes_read;
  }
  CloseHandle(file);
  return true;
}

}  // namespace

void ShowcaseResourceFetcher::FetchResource(
    std::shared_ptr<lynx::pub::resource::LynxResourceRequest> request,
    std::shared_ptr<lynx::pub::resource::LynxResourceResponse> response) {
  if (!request || !response) {
    return;
  }
  const char* raw_url = request->GetUrl();
  std::string path = raw_url ? raw_url : "";
  if (path.rfind("file:///", 0) == 0) {
    path = path.substr(8);
  } else if (path.rfind("file://", 0) == 0) {
    path = path.substr(7);
  }

  std::vector<uint8_t> bytes;
  if (!ReadLocalFileUtf8(path, &bytes)) {
    response->SetCode(-1);
    response->SetErrorMessage("Local resource not found");
    response->Complete();
    return;
  }

  response->SetCode(0);
  if (!bytes.empty()) {
    auto* buf = new uint8_t[bytes.size()];
    std::memcpy(buf, bytes.data(), bytes.size());
    response->SetData(
        buf, bytes.size(),
        [](uint8_t* ptr, size_t, void*) { delete[] ptr; }, nullptr);
  }
  response->Complete();
}
