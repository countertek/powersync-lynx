## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default role names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Lynx-bundle JS

Normative spec: `docs/spec.md` (captain override: Client is TypeScript sources only — no committed `.js` / `.d.ts` emit). This package (`powersync-lynx`) ships the Autolink skeleton, Lynx-bundle TypeScript in `src/` (`PowerSyncDatabase`, Adapter, `LynxRemote`), Host helper in `src/web-host/`, and Native Module dirs (`android/`, `ios/`, `shared/`, `lynxtron/`, `dist/`). Native Module methods take a function callback; do not treat them as Promises. Install with pnpm 12 (`packageManager` in `package.json`); do not use the npm CLI. Adapter checks: `pnpm test` (`node --test test/*.test.ts`). Lint/format/typecheck: `pnpm lint`, `pnpm fmt`, `pnpm typecheck`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
