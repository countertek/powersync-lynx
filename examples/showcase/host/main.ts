import "@lynx-js/web-core/client";
import { attach, type LynxViewHost } from "powersync-lynx/web-host";

const view = document.querySelector("lynx-view");
if (view == null) {
  throw new Error("host page is missing <lynx-view>");
}

const params = new URLSearchParams(window.location.search);
const device = params.get("device")?.trim() || "web";
const globalProps = JSON.stringify({ device });
view.setAttribute("global-props", globalProps);

const host = view as LynxViewHost & { globalProps?: { device: string } };
host.globalProps = { device };

// attach must run before url/start so lynx-bg sees NativePowerSyncModule.
attach(host);

// web-core's createIFrameRealm correlates the MTS iframe's ready message with
// `event.source === iframe.contentWindow`, which is unreliable while the host
// page is still loading and can hang the first cold load (upstream:
// lynx-family/lynx-stack#3874). This package applies a pnpm patch that
// correlates the ready message with a unique per-realm token instead, so the
// card can boot immediately without gating on window.load.
host.url = "/main.web.bundle";
view.setAttribute("url", "/main.web.bundle");
