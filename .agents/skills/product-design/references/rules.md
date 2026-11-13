# Rules with evidence

Only rules the code or the repository already follows. IDs for `copy.md` rules are defined there.

| ID                            | Rule                                                                                                                     | Evidence                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| rule/tokens-not-raw-values    | Components use colour roles, `typography`, `space`, `radius`; no raw hex or font sizes in views.                         | `src/theme/tokens.ts` header comment; #78.                                            |
| rule/contrast-tested          | Every text role on every surface passes WCAG 4.5:1 (3:1 large) in both schemes.                                          | `apps/mobile/test/theme-contrast.test.ts`.                                            |
| rule/touch-44-driving-56      | Interactive targets at least 44 pt; driving controls 56 pt. `IconButton` clamps to 44.                                   | `touchTarget`; `ui/icon-button.tsx`, `ui/button.tsx`.                                 |
| rule/reduce-motion            | Animations pass `ReduceMotion.System`.                                                                                   | `motion` comment; `map-notice.tsx`, `map-controls.tsx`, `app-tab-bar.tsx`.            |
| rule/guidance-on-ink          | Active guidance is drawn on ink in both schemes.                                                                         | `guidanceColors`; #84 ("banner is always ink").                                       |
| rule/native-owns-guidance     | Matching, speech, rerouting, camera eligibility, speeding verdict, current road: native. Phone and CarPlay present them. | `AGENTS.md`; #75, #77.                                                                |
| rule/old-server-quiet         | A missing `/v2/*` capability is a quiet, remembered "not available", never an error or a claim.                          | #84, #85 (404 for `/v2/community/*`, `/v2/traffic/*`, one status request per launch). |
| rule/no-source-grepping-tests | UI behaviour is tested through extracted logic, not by grepping source text.                                             | #78; `AGENTS.md` (Lessons).                                                           |
| rule/verify-on-a-render       | Visual claims require a simulator screenshot; say what was not rendered.                                                 | #78 and #84 "Not verified" sections; `AGENTS.md`.                                     |
