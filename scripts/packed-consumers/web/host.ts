import { attach, type LynxViewHost } from "powersync-lynx/web-host";

export function attachHost(view: LynxViewHost) {
  return attach(view);
}
