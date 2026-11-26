# 04: Runnable Lynxtron showcase host (`examples/hosts/lynxtron/`) and streaming check

Type: task
Status: ready-for-agent
Blocked by: 02, 03
Spec: ../spec.md (#68)
GitHub: #71

## Scope

Replace the stale recipe-only `examples/hosts/desktop/` with a runnable cross-platform Lynxtron showcase app (`examples/hosts/lynxtron/`) that Autolinks `powersync-lynx`, loads the shared ReactLynx TODO bundle, and verifies live `/sync/stream` behavior.

### Changes

1. **Create `examples/hosts/lynxtron/`**:
   - `package.json`, Lynxtron config (`pluginLynxtron()` loading `powersync-lynx/lynxtron`), main process entry creating a `LynxWindow` pointing at `examples/showcase/lynx-dist/main.lynx.bundle`.
   - Server addressing matching `examples/hosts/ios` and `android` (`DEMO_DEVICE`, `DEMO_API_URL=http://127.0.0.1:8081`, `POWERSYNC_URL=http://127.0.0.1:8080`, CLI flags / env overrides for two-client runs).
   - `README.md` with install, build, run, two-client walkthrough, and verified environment matrix.
2. **Remove `examples/hosts/desktop/`**:
   - Delete stale `examples/hosts/desktop/README.md` and unwired `examples/hosts/desktop/lynxtron.config.ts`.
   - Update cross-references in `examples/README.md`.
3. **Verify `/sync/stream` on Lynxtron**:
   - Run against `examples/docker-compose.yml` (`--profile sync`).
   - Record concrete evidence for Ticket `06`: does Lynxtron's built-in `fetch` deliver incremental NDJSON chunks (`ps_buckets > 0`, live cross-client updates while open) and cleanly cancel via `AbortSignal` (`Go offline` / `Reconnect`)?

## Acceptance Criteria

- `examples/hosts/lynxtron/` launches on macOS arm64 (and builds/runs on Windows x64), paints the TODO showcase UI, opens local SQLite via Autolinked `NativePowerSyncModule`, and persists todos across restarts.
- Two-client sync with the web showcase (`http://localhost:4173/?device=web-b`) is tested and results (pass or exact streaming/abort failure mode) are documented as input to Ticket `06`.
- `examples/hosts/desktop/` is removed and no dangling links remain.

## Verification

- `pnpm --dir examples/showcase build`
- Launch `examples/hosts/lynxtron/` against `examples/docker-compose.yml` (`--profile sync`); verify local DB ready, add/toggle/delete/persist, upload, download, and offline/reconnect stream cancel.
