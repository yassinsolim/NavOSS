## Summary

<!-- What changed, and why? -->

## Validation

<!-- List the exact commands and manual checks run. -->

- [ ] Focused tests pass
- [ ] `corepack pnpm format:check`
- [ ] `corepack pnpm check`
- [ ] `corepack pnpm lint`
- [ ] `corepack pnpm test`
- [ ] `corepack pnpm build`
- [ ] Native or Maestro tests run when applicable
- [ ] UI changes were checked on a simulator render (light and dark, large text), not only from source
- [ ] Where the change depends on a `/v2/*` server capability, it was checked against the deployed (older) API or its recorded responses and degrades quietly

## Safety and Privacy

- [ ] No credentials, precise personal locations, private addresses, or raw trip traces are included
- [ ] User-facing navigation/data-source claims match measured behavior
- [ ] New data sources include provenance, license, attribution, and freshness information
- [ ] Claims about capabilities, coverage and data collection are true of the deployed service and the shipped build, and `docs/privacy.md` and `apps/site/src/privacy.html` agree with any behaviour change
- [ ] Regression tests for security or privacy fixes were mutation-checked (fail when the fix is removed)

## Screenshots

<!-- Include before/after evidence for user-facing changes. Remove this section otherwise. -->
