# product-design skill: load order and governance

Load order: `SKILL.md` (modes, contract, workflow), then only the references the workflow routes to. `references/coverage-gaps.md` is always safe to read: it lists what has no standard yet.

Governance:

- Every rule names its evidence (a file, a test or a merged PR). A rule without evidence belongs in `coverage-gaps.md`.
- Exemplars document merged PRs only and carry the mistakes caught as well as the decisions.
- When code changes a token, primitive, contract field or user-facing string cited here, update the reference in the same PR.
- This skill does not replace `AGENTS.md`, `docs/privacy.md` or `docs/architecture/carplay.md`; it routes to them. It contains no lint rules today; contrast is the one deterministic UI check (`apps/mobile/test/theme-contrast.test.ts`).
