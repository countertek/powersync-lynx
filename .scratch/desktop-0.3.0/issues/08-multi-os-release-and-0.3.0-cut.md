# 08: Multi-OS `release.yml`, tarball hygiene, docs bump, and `0.3.0` release cut

Type: task
Status: ready-for-agent
Blocked by: 06, 07
Spec: ../spec.md (#68)
GitHub: #75

## Scope

Wire up the multi-OS npm release pipeline to assemble prebuilt `macos/arm64` and `windows/x64` artifacts into the single `powersync-lynx` package, verify tarball hygiene, update consumer-facing docs, and cut `0.3.0`.

### Changes

1. **Multi-OS `.github/workflows/release.yml`**:
   - `build-macos` (`macos-14` arm64): fetch `libpowersync_aarch64.macos.dylib`, build ad-hoc signed `dist/macos/arm64/powersync-lynx.node`, run `check-native-artifacts.mjs --macos`, upload `dist-macos-arm64` artifact.
   - `build-windows` (`windows-latest` x64, MSVC): fetch `powersync_x64.dll`, build `dist/windows/x64/powersync-lynx.node`, run `check-native-artifacts.mjs --windows`, upload `dist-windows-x64` artifact.
   - `publish` (`ubuntu-latest`): download both desktop artifacts into `dist/`, run `prepack` (`typecheck` + `bundle-web-host-factory` + `--sqlite`), run `node scripts/check-native-artifacts.mjs` + `pnpm check-packed-consumers`, assert tarball file list contains **only** expected `dist/` paths (`dist/web-host/factory.js`, `dist/macos/arm64/*`, `dist/windows/x64/*` — fail if `dist/macos/x64` or `dist/linux` appear), and run `npm publish --access public`.
2. **Packed-consumer & tarball checks (`scripts/check-packed-consumers.mjs`)**:
   - Assert tarball contains `dist/macos/arm64/{powersync-lynx.node,libpowersync_aarch64.macos.dylib}` and `dist/windows/x64/{powersync-lynx.node,powersync_x64.dll}` when publishing (or via `--require-desktop-binaries` flag in release), and never includes `macos/x64` or `linux/x64`.
   - Verify `powersync-lynx/lynxtron` CJS export resolves cleanly from the packed consumer tarball.
3. **Package metadata & user-facing docs**:
   - Bump `package.json` `version` to `0.3.0`, update `description` and `keywords` (`macos`, `windows`, `lynxtron`, `desktop`).
   - Update `README.md` and `examples/README.md` to reflect verified macOS + Windows (native + Lynxtron) support and link to `examples/hosts/{macos,windows,lynxtron}/README.md`.
4. **Pre-release E2E sign-off**:
   - Verify live two-client sync across all four combinations (`macos/arm64` native, `macos/arm64` Lynxtron, `windows/x64` native, `windows/x64` Lynxtron) + run `pnpm publish-dry-run` against local Verdaccio.

## Acceptance Criteria

- Dry-run release workflow / tarball pack contains exact `dist/macos/arm64/*`, `dist/windows/x64/*`, and `dist/web-host/factory.js` with no stray architectures, and web consumer bundle stays unaffected.
- `README.md`, `examples/README.md`, and `package.json` accurately describe `0.3.0` desktop support.
- All CI jobs (Linux, macOS, Windows) and live two-client sync checks pass before tagging `v0.3.0`.

## Verification

- `pnpm test && pnpm typecheck && pnpm lint && pnpm check-packed-consumers && make test`
- `pnpm publish-dry-run` (against local Verdaccio)
- GitHub Actions release workflow dry-run / tag `v0.3.0`.
