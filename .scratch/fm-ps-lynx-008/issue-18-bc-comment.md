# Issue #18 comment (B+C landed) — paste if Issues API 403s

FM-PS-LYNX-008 **B+C** is open as a PR: Native Module HTTP is a separate sub-interface (`NativeSyncHttp`) on the Autolink `NativePowerSyncModule` lookup (SQL RPC unchanged). Android and iOS emit `onData*` → `onError?` → `onEnd`. Idle-complete is one fallback envelope (`body` UTF-8 / `bodyBase64`) behind `streamingId`, with shared policy in `shared/sync_http_policy.h`. Desktop N-API stays SQL-only. ADR-0003 + spec transport update. Showcase HTTP service is Connector/JSON only. Stacks on A (#25).
