# Survey Lynx networking for the PowerSync sync protocol

Type: research
Status: claimed

## Question

Can the PowerSync JavaScript sync loop (HTTP streaming and/or WebSocket) run in Lynx JS, or does the Adapter need native HTTP?

## Constraints

- Primary sources: PowerSync protocol / JS `connectionMethod` (HTTP default on Expo and Web; WebSocket on plain RN because `fetch` cannot stream); Lynx `fetch`, `lynx.EventSource`, experimental fetch streaming, host HTTP Service; Lynx-for-Web uses browser `fetch`.
- Cover: Connector `fetchCredentials` / `uploadData` (app JS, Lynx `fetch` vs browser `fetch`); keepalive / redirect / Blob gaps; whether `common` owns the stream or the platform package does.
- Flag anything that forces a native sync transport despite `@powersync/common` in JS.

Write findings to `docs/research/lynx-powersync-network.md` on branch `research/lynx-powersync-network`.

## Comments

Charting session 2026-09-06: claimed for parallel research on `research/lynx-powersync-network`.
