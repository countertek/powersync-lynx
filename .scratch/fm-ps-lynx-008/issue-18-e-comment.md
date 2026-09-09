# Issue #18 comment (E landed) — paste if Issues API 403s

FM-PS-LYNX-008 **E** is open as a PR: one `LynxHost` interface + PrimJS adapter + fake test adapter. Native Module lookup, GlobalEventEmitter, platform, text codec, fetch, and AbortController install now go through `src/host.ts`. `LynxRemote` transport is unchanged (A deferred: no `SyncStreamTransport`, no deletion of FM-PS-LYNX-003). Stacks on H (#23) so typecheck/lint/CI stay green.
