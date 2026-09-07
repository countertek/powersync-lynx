# Assemble the Client spec

Type: grilling
Status: resolved
Blocked by: 07, 08, 09, 10

## Question

What is the single locked spec a later session implements without re-deciding architecture, API, Adapter, Host helper, or package layout?

Honor every closed ticket on this map and `CONTEXT.md`. Produce `docs/spec.md` (and ADRs only if a choice is hard to reverse, surprising, and a real trade-off). Do not implement the package.

HITL: `/grilling` + `/domain-modeling`. Confirm shared understanding, then write the spec. When this ticket closes, the map is done.

## Answer

One implementer-facing spec at [docs/spec.md](../../../docs/spec.md). Reading order: product → public API → Lynx JS runtime → Adapter → Host helper → package/floors → out of scope. Normative and self-contained; `.scratch` assets stay ticket history. No third ADR (0001 and 0002 already hold the splits). Glossary **attach** added to `CONTEXT.md`. CI/release/real npm scope and a later ReactLynx hooks package moved to map **Out of scope**. Closing this ticket finishes the map. Planning only — no package.

## Comments

2026-09-07: claimed to grill and assemble `docs/spec.md`. Planning only — no package, no implementation. Honor closed 07–10; do not re-decide API, Adapter, Host helper, or package layout.

2026-09-07 grilling round 1: 07–10 frozen. Frontier is spec assembly only: `docs/spec.md` form, leftover map fog, glossary (`attach`).

2026-09-07 grilling round 1 answers: Q1 A (one reading-order `docs/spec.md`); Q2 A (leftover fog → Out of scope); Q3 A (glossary **attach**). Frontier empty; spec written; map done.
