# Issue #18 body addendum — paste at the top of #18 if the Issues API 403s

> **Post-#32 status (FM-PS-LYNX-010, 2026-09-09).** Every lettered item from the original Fable 5.1 pass (FM-PS-LYNX-007) is on `main` at `442ec6fda09f`:
>
> | Item | Landed in | On main as |
> | --- | --- | --- |
> | H verification gate | #23 | `.github/workflows/ci.yml`, Node `>=22.18`, `consumer-rules.pro` |
> | E one `LynxHost` | #32 | `src/host.ts` (`PrimJSLynxHost` + `test/fake-lynx-host.ts`) |
> | A `SyncStreamTransport` | #32 | `src/sync/transport/SyncStreamTransport.ts`; `LynxRemote.fetch` is a pick |
> | B NativeSyncHttp split from SQL RPC | #32 | `android/.../NativeSyncHttp.java`, `ios/src/NativeSyncHttp.mm`; ADR-0003 |
> | C one idle-complete envelope | #32 | `shared/sync_http_policy.h`, `NativeHttpFetchEnvelope` |
> | F shared NDJSON fixtures | #32 | `shared/fixtures/sync-stream.json` (JS, Linux, iOS, Android) |
> | D Android SQL on shared `ps_sql` | #32 | `PsSqlEngine.java` → `ps_sql_jni.cc` → `shared/ps_sql.cc` |
> | G iOS host-provided event sender | #32 | `NativePowerSyncModule+StreamEvents.h`; `make test` greps the `UIWindow` walk is gone |
>
> This issue is now **historical**: the original improvement list and its A–H implementation trail. The fresh post-#32 backlog (a second `/improve-codebase-architecture` pass on the implemented tree) is tracked in the FM-PS-LYNX-010 follow-up issue (`.scratch/fm-ps-lynx-010/follow-up-issue.md` until the Issues API allows creating it). Recommend closing #18 once that follow-up exists.
