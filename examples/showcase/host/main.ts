import "@lynx-js/web-core/client";
import { attach, type LynxViewHost } from "powersync-lynx/web-host";

const view = document.querySelector("lynx-view");
if (view == null) {
  throw new Error("host page is missing <lynx-view>");
}

const params = new URLSearchParams(window.location.search);
const device = params.get("device")?.trim() || "web";
const props: { device: string; demoApiUrl?: string; powersyncUrl?: string } = { device };
const demoApiUrl = params.get("demoApiUrl")?.trim();
const powersyncUrl = params.get("powersyncUrl")?.trim();
if (demoApiUrl) {
  props.demoApiUrl = demoApiUrl;
}
if (powersyncUrl) {
  props.powersyncUrl = powersyncUrl;
}
const globalProps = JSON.stringify(props);
view.setAttribute("global-props", globalProps);

const host = view as LynxViewHost & {
  globalProps?: { device: string; demoApiUrl?: string; powersyncUrl?: string };
};
host.globalProps = props;

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
