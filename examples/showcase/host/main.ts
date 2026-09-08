import "@lynx-js/web-core/client";
import { attach, type LynxViewHost } from "powersync-lynx/web-host";

const view = document.querySelector("lynx-view");
if (view == null) {
  throw new Error("host page is missing <lynx-view>");
}

const host = view as LynxViewHost;
// attach must run before url/start so lynx-bg sees NativePowerSyncModule.
attach(host);
host.url = "/main.web.bundle";
view.setAttribute("url", "/main.web.bundle");
