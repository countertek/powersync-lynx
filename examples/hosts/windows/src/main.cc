#include <windows.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "NativePowerSyncModule.h"
#include "capi/lynx_log_capi.h"
#include "lynx_env.h"
#include "lynx_load_meta.h"
#include "lynx_service_center.h"
#include "lynx_template_data.h"
#include "lynx_view.h"
#include "lynx_view_client.h"
#include "win_utf8.h"

#include "HostConfig.h"
#include "ShowcaseHttpService.h"
#include "ShowcaseResourceFetcher.h"

namespace {

constexpr UINT_PTR kSmokeTimerId = 1;
constexpr UINT_PTR kExitPollTimerId = 2;
constexpr int kInitialWidth = 520;
constexpr int kInitialHeight = 820;

const char* LogLevelName(lynx_log_level_e level) {
  switch (level) {
    case LYNX_LOG_VERBOSE:
      return "V";
    case LYNX_LOG_DEBUG:
      return "D";
    case LYNX_LOG_INFO:
      return "I";
    case LYNX_LOG_WARNING:
      return "W";
    case LYNX_LOG_ERROR:
      return "E";
    case LYNX_LOG_FATAL:
      return "F";
  }
  return "?";
}

void OnLynxLog(lynx_log_level_e level, const char* tag, const char* msg) {
  if (level < LYNX_LOG_INFO) {
    return;
  }
  std::fprintf(stderr, "[Lynx/%s][%s] %s\n", LogLevelName(level),
               tag ? tag : "lynx", msg ? msg : "");
  std::fflush(stderr);
}

class ShowcaseViewClient final : public lynx::pub::LynxViewClient {
 public:
  std::atomic<bool> load_succeeded{false};
  std::atomic<bool> first_screen{false};
  std::atomic<bool> runtime_ready{false};
  std::atomic<bool> had_error{false};

  void OnPageStart(const char* url) override {
    std::fprintf(stderr, "[LynxView] OnPageStart: %s\n", url ? url : "");
    std::fflush(stderr);
  }
  void OnLoadSuccess() override {
    load_succeeded.store(true);
    std::fprintf(stderr, "[LynxView] OnLoadSuccess\n");
    std::fflush(stderr);
  }
  void OnFirstScreen() override {
    first_screen.store(true);
    std::fprintf(stderr, "[LynxView] OnFirstScreen\n");
    std::fflush(stderr);
  }
  void OnRuntimeReady() override {
    runtime_ready.store(true);
    std::fprintf(stderr, "[LynxView] OnRuntimeReady\n");
    std::fflush(stderr);
  }
  void OnReceivedError(int error_code, const char* message) override {
    // Lynx CSS property warnings (e.g. 130300 "CSS length need units") are non-fatal.
    if (error_code < 130000 || error_code >= 140000) {
      had_error.store(true);
    }
    std::fprintf(stderr, "[LynxView] OnReceivedError(%d): %s\n", error_code,
                 message ? message : "");
    std::fflush(stderr);
  }
  void OnDestroy() override {
    std::fprintf(stderr, "[LynxView] OnDestroy\n");
    std::fflush(stderr);
  }
};

struct WindowState {
  std::unique_ptr<lynx::pub::LynxView> lynx_view;
  std::shared_ptr<ShowcaseViewClient> view_client;
  std::wstring exit_file_wide;
  int exit_code = 0;
  bool smoke_test = false;
};

float WindowDpiScale(HWND hwnd) {
  UINT dpi = GetDpiForWindow(hwnd);
  return dpi > 0 ? static_cast<float>(dpi) / 96.0f : 1.0f;
}

bool ReadFileBytesUtf8(const std::string& path, std::vector<uint8_t>* out) {
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
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0) {
    CloseHandle(file);
    return false;
  }
  out->resize(static_cast<size_t>(size.QuadPart));
  size_t total = 0;
  while (total < out->size()) {
    DWORD chunk = static_cast<DWORD>(
        (out->size() - total) > 0x1000000 ? 0x1000000 : (out->size() - total));
    DWORD read = 0;
    if (!ReadFile(file, out->data() + total, chunk, &read, nullptr) ||
        read == 0) {
      CloseHandle(file);
      return false;
    }
    total += read;
  }
  CloseHandle(file);
  return true;
}

std::string ResolveIcuDataPath() {
  std::string exe_dir = ExecutableDirectoryUtf8();
  if (exe_dir.empty()) {
    return "";
  }
  std::string candidate = exe_dir + "\\data\\icudtl.dat";
  std::wstring wide = ps_sql::Utf8ToWide(candidate);
  DWORD attrs = GetFileAttributesW(wide.c_str());
  if (attrs != INVALID_FILE_ATTRIBUTES &&
      (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    return candidate;
  }
  return "";
}

LRESULT CALLBACK MainWindowProc(HWND hwnd,
                                UINT msg,
                                WPARAM wparam,
                                LPARAM lparam) {
  auto* state =
      reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  switch (msg) {
    case WM_SIZE: {
      if (state && state->lynx_view) {
        RECT rect{};
        GetClientRect(hwnd, &rect);
        float w = static_cast<float>(rect.right - rect.left);
        float h = static_cast<float>(rect.bottom - rect.top);
        float scale = WindowDpiScale(hwnd);
        if (w > 0.0f && h > 0.0f) {
          state->lynx_view->UpdateScreenMetrics(w, h, scale);
          state->lynx_view->SetFrame(0.0f, 0.0f, w, h);
        }
      }
      return 0;
    }
    case WM_TIMER: {
      if (wparam == kExitPollTimerId && state && !state->exit_file_wide.empty()) {
        if (GetFileAttributesW(state->exit_file_wide.c_str()) !=
            INVALID_FILE_ATTRIBUTES) {
          KillTimer(hwnd, kExitPollTimerId);
          KillTimer(hwnd, kSmokeTimerId);
          state->exit_code = 0;
          DestroyWindow(hwnd);
        }
        return 0;
      }
      if (wparam == kSmokeTimerId && state && state->smoke_test) {
        KillTimer(hwnd, kSmokeTimerId);
        KillTimer(hwnd, kExitPollTimerId);
        bool ok = state->view_client &&
                  state->view_client->load_succeeded.load() &&
                  state->view_client->runtime_ready.load() &&
                  !state->view_client->had_error.load();
        std::fprintf(
            stderr,
            "[PowerSyncLynxShowcase] smoke-test complete: "
            "loadSuccess=%d firstScreen=%d runtimeReady=%d error=%d\n",
            state->view_client && state->view_client->load_succeeded.load() ? 1
                                                                            : 0,
            state->view_client && state->view_client->first_screen.load() ? 1
                                                                          : 0,
            state->view_client && state->view_client->runtime_ready.load() ? 1
                                                                           : 0,
            state->view_client && state->view_client->had_error.load() ? 1 : 0);
        std::fflush(stderr);
        state->exit_code = ok ? 0 : 1;
        DestroyWindow(hwnd);
        return 0;
      }
      break;
    }
    case WM_DESTROY: {
      if (state && state->lynx_view && state->view_client) {
        state->lynx_view->RemoveClient(state->view_client);
      }
      if (state) {
        state->lynx_view.reset();
      }
      PostQuitMessage(state ? state->exit_code : 0);
      return 0;
    }
    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

}  // namespace

int main() {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  HostConfig config = HostConfig::FromProcess();

  lynx_log_init(OnLynxLog);
  lynx_log_set_minimum_level(LYNX_LOG_INFO);

  auto& env = lynx::pub::LynxEnv::GetInstance();
  std::string icu_path = ResolveIcuDataPath();
  if (!icu_path.empty()) {
    env.SetICUDataPath(icu_path.c_str());
  }

  // Register NativePowerSyncModule from powersync_lynx_native.
  env.RegisterNativeModule("NativePowerSyncModule", CreateNativePowerSyncModule,
                           nullptr);

  // Register WinHTTP-backed LynxHttpService.
  auto http_service = std::make_shared<ShowcaseHttpService>();
  lynx::pub::LynxServiceCenter::GetInstance().RegisterService(http_service);

  std::fprintf(stderr,
               "[PowerSyncLynxShowcase] Lynx SDK %s | device=%s | demoApi=%s | "
               "powersync=%s | bundle=%s\n",
               env.GetVersion() ? env.GetVersion() : "unknown",
               config.device.c_str(), config.demo_api_url.c_str(),
               config.powersync_url.c_str(), config.bundle_path.c_str());
  std::fflush(stderr);

  HINSTANCE instance = GetModuleHandleW(nullptr);
  const wchar_t* class_name = L"PowerSyncLynxShowcaseWindow";

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = MainWindowProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(0x05, 0x09, 0x10));
  wc.lpszClassName = class_name;
  if (RegisterClassExW(&wc) == 0) {
    std::fprintf(stderr,
                 "[PowerSyncLynxShowcase] RegisterClassExW failed (%lu)\n",
                 static_cast<unsigned long>(GetLastError()));
    return 1;
  }

  std::wstring title = ps_sql::Utf8ToWide("PowerSync Lynx Showcase (" +
                                               config.device + ")");
  HWND hwnd = CreateWindowExW(
      0, class_name, title.c_str(), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT,
      CW_USEDEFAULT, kInitialWidth, kInitialHeight, nullptr, nullptr, instance,
      nullptr);
  if (hwnd == nullptr) {
    std::fprintf(stderr,
                 "[PowerSyncLynxShowcase] CreateWindowExW failed (%lu)\n",
                 static_cast<unsigned long>(GetLastError()));
    return 1;
  }

  WindowState state;
  state.smoke_test = config.smoke_test;
  if (!config.exit_file.empty()) {
    state.exit_file_wide = ps_sql::Utf8ToWide(config.exit_file);
  }
  SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&state));

  if (!config.headless) {
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
  }

  RECT client_rect{};
  GetClientRect(hwnd, &client_rect);
  float width = static_cast<float>(client_rect.right - client_rect.left);
  float height = static_cast<float>(client_rect.bottom - client_rect.top);
  if (width <= 0.0f) {
    width = static_cast<float>(kInitialWidth);
  }
  if (height <= 0.0f) {
    height = static_cast<float>(kInitialHeight);
  }
  float dpi_scale = WindowDpiScale(hwnd);

  auto resource_fetcher = std::make_shared<ShowcaseResourceFetcher>();

  lynx::pub::LynxView::Builder builder;
  builder.SetScreenSize(width, height, dpi_scale)
      .SetFrame(0.0f, 0.0f, width, height)
      .SetFontScale(1.0f)
      .SetParent(static_cast<NativeWindow>(hwnd))
      .SetGenericResourceFetcher(resource_fetcher);
  if (!icu_path.empty()) {
    builder.SetICUDataPath(icu_path);
  }

  state.lynx_view = builder.Build();
  state.view_client = std::make_shared<ShowcaseViewClient>();
  state.lynx_view->AddClient(state.view_client);

  std::vector<uint8_t> bundle_bytes;
  if (!ReadFileBytesUtf8(config.bundle_path, &bundle_bytes)) {
    std::fprintf(stderr,
                 "[PowerSyncLynxShowcase] Failed to read Lynx bundle at: %s\n"
                 "Build it first with: pnpm --dir examples/showcase build\n",
                 config.bundle_path.c_str());
    std::fflush(stderr);
    DestroyWindow(hwnd);
    return 1;
  }

  auto* owned_bytes = new uint8_t[bundle_bytes.size()];
  std::memcpy(owned_bytes, bundle_bytes.data(), bundle_bytes.size());

  auto load_meta = std::make_shared<lynx::pub::LynxLoadMeta>();
  load_meta->SetUrl("main.lynx.bundle");
  load_meta->SetBinaryData(
      owned_bytes, bundle_bytes.size(),
      [](uint8_t* ptr, size_t, void*) { delete[] ptr; }, nullptr);
  load_meta->SetGlobalProps(
      std::make_shared<lynx::pub::LynxTemplateData>(config.GlobalPropsJson()));
  state.lynx_view->LoadTemplate(load_meta);

  if (!state.exit_file_wide.empty()) {
    SetTimer(hwnd, kExitPollTimerId, 200, nullptr);
  }
  if (config.smoke_test) {
    UINT timeout_ms = static_cast<UINT>(config.smoke_seconds * 1000.0);
    if (timeout_ms < 500) {
      timeout_ms = 500;
    }
    SetTimer(hwnd, kSmokeTimerId, timeout_ms, nullptr);
  }

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return static_cast<int>(msg.wParam);
}
