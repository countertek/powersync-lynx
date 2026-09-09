# Issue #18 comment (native Mac build breakers) — paste if Issues API 403s

FM-PS-LYNX-008 **native host compile fixes** (Mac tip verify) is open as a PR stacked on web download (#29). Surgical only — no architecture change.

**iOS:** `NativeSyncHttp.mm` could not message `sendGlobalEvent:withParams:` on `id` because the pod TU does not import LynxView. Declare a local `PSLynxStreamEventSender` protocol (same idea as the iOS fixture sender) and cast after `respondsToSelector`. Showcase `ViewController` `setSharedStreamEventSender:` is unchanged.

**Android NDK:** `AttachEnv` in `ps_sql_jni.cc` passed `void**` into `AttachCurrentThread`; Android NDK wants `JNIEnv**`. `#ifdef __ANDROID__` keeps desktop/Linux JNI (`void**`) working for `make test`.

Web download / host-fetch NDJSON fix is untouched. `pnpm typecheck/lint/test` and `make test` on Linux.
