---
name: product-design
description: >-
  Single entry point for product design and user-facing implementation in NavOSS: the phone app
  (apps/mobile/src), the CarPlay templates and map (apps/mobile/carplay, the Swift module's
  CarPlay* files), spoken guidance wording, and the public website (apps/site/src). Use whenever
  work changes what a driver sees, hears, understands, chooses or does: shaping flows, building or
  redesigning sheets, banners and templates, reviewing screenshots or diffs, writing or changing
  user-facing copy, privacy or capability wording, and designing loading, empty, error, offline,
  location-denied or "feature not available on this server" states. Also use when a backend or
  contract change alters what the user can see (a new server flag, a new optional route field).
  Not for backend-only work, tests with no shipped UI impact, telemetry, generated files, or
  release notes.
---

# NavOSS product design

A driver glances at this product for a second or two while moving. Working code is not enough: choose the right interaction, say only what the product really does, cover every state the product can enter, and look at the rendered surface.

## Operating contract

- **Start with the job.** Who is acting (driver, passenger, a person parked at home planning), what they are trying to do, which object is involved (a place, a route, a report), and what the system will change or send.
- **Honest capability claims beat polish.** Never show, name or imply a capability the deployed server or the shipped build lacks. See `references/copy.md` and `AGENTS.md`.
- **Privacy copy is a contract.** Any text about what leaves the phone must match `docs/privacy.md`. Change the policy in the same change, or do not change the copy.
- **Glanceable first, safe while moving.** Primary driving information is large, high contrast and short; anything that needs reading or deciding is for a parked or passenger-operated moment. See `references/surfaces.md`.
- **Design every reachable state.** Loading, empty, error, offline, location denied, feature not available on this server, degraded data. Only states the product can really enter; but not only the populated one. See `references/resilience.md`.
- **Use the system, not new decoration.** Tokens and primitives in `apps/mobile/src/theme` and `src/ui` come first. Do not add a raw colour, font size or ad-hoc control. See `references/interface-quality.md`.
- **Treat shipped code as evidence, not precedent.** It shows what exists, not why. Where the code and a rule here disagree, say so and record the gap; do not silently promote one screen into a rule.
- **Verify the rendered surface.** Source inspection shows behaviour. A simulator screenshot (light and dark, default and large text) shows quality. Never claim visual verification from source alone. CarPlay templates cannot be run on this project's Mac (Xcode 27.2): state exactly what was and was not exercised.
- **Never touch the owner's phone.** Verification uses simulators and the harnesses documented in `AGENTS.md`.

## Request modes

Resolve the mode from the verb before acting.

| Mode      | Typical request                                             | Required behaviour                                                                                                                 |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Shape     | "How should this work?", a feature brief with no settled UI | Frame job, evidence and alternatives; define flow, states, copy, acceptance criteria and open decisions. Do not edit unless asked. |
| Implement | "Build", "fix", "make it match"                             | Resolve material decisions, then make the smallest coherent end-to-end change, including every state and both colour schemes.      |
| Review    | "Audit", "what's wrong with this screen?", code review      | Inspect source and rendered evidence; report prioritised findings (P0 to P3). Do not edit unless asked.                            |
| Copy      | "Fix the wording", "rewrite these errors", site text        | Edit user-facing language, accessible names and directly required markup only. Check every claim against `references/copy.md`.     |
| Harden    | "Polish", "handle edge cases", "make it accessible"         | Keep the settled direction; fix states, large text, Reduce Motion, VoiceOver, small screens, old-server behaviour.                 |

A material decision changes the user's task, default, scope, consequence, navigation, interaction surface or reachable states. Token replacement and established primitive substitution usually are not.

## Decision authority

1. The owner's explicit goal and constraints.
2. System truth: what the code and the deployed server actually do (`/v2/config`, `/v2/traffic/status`, recorded fixtures).
3. `AGENTS.md`, `docs/privacy.md`, `docs/architecture/carplay.md` and this skill's references.
4. Accepted decisions in `exemplars/` (each cites a merged PR).
5. Verified adjacent patterns in the same area.
6. General interface heuristics.

## Workflow

1. **Set scope and mode.** Name the surface (phone, CarPlay, website, speech) and the mode.
2. **Load context.** Read `AGENTS.md`, the surface file in `references/surfaces*.md`, and the logic that decides what is possible (server flags, native contract fields, permissions).
3. **Model the decision.** For Shape, Implement, Harden or any flow change write a short brief: user, job, current behaviour, outcome, non-goals, what is sent or changed, reversibility, and which server capabilities it depends on. Read `references/product-judgment.md`.
4. **Map states.** List entry points, sheets, overlays and exits, then the reachable states from `references/resilience.md`. Include "old production server" as a state for anything that depends on `/v2/*`.
5. **Load routed references.**

   | Need                                     | Load                                                                                    |
   | ---------------------------------------- | --------------------------------------------------------------------------------------- |
   | Product or flow decision                 | `product-judgment.md`                                                                   |
   | Tokens, primitives, layout, motion       | `interface-quality.md`                                                                  |
   | Any wording, accessible name, speech     | `copy.md`, `glossary.md`                                                                |
   | Phone, CarPlay or website specifics      | `surfaces.md`, then `surfaces-phone.md`, `surfaces-carplay.md` or `surfaces-website.md` |
   | Missing, slow, denied, unsupported, huge | `resilience.md`                                                                         |
   | Anything not covered by a rule here      | `coverage-gaps.md` (then add the gap if it is new)                                      |
   | Interaction patterns already in use      | `patterns.md`; decisions behind them in `exemplars/`                                    |

6. **Decide, then implement.** Be able to say what problem the change solves, why this primitive, what the user is told about consequences, and what evidence backs it.
7. **Verify.** Run the repository gates (`AGENTS.md`), then the rendered checks in the list below. Report what was exercised and what was not.

### Verification checklist (rendered, not from source)

- The primary job works end to end on the simulator (see `AGENTS.md` for the dev-client commands).
- Light and dark; default text size and the largest accessibility size; text-size change while the screen is open (a known weak spot, `exemplars/pr-84-routes-v2-clients.md`).
- Reduce Motion on; VoiceOver labels present on every control (inspect the accessibility tree where listening is not possible, and say so).
- Each changed state: loading, empty, error, offline (API stopped), location denied, and the old server (point the app at a server that answers 404 for `/v2/*`, or use the recorded production fixtures).
- Touch targets at least 44 pt; driving controls 56 pt.
- For website changes: mobile and desktop widths, light and dark, `corepack pnpm --filter @navoss/site check` and `test`.
- For CarPlay changes: the visual harness (`validate:navigation:ios --carplay-only`) and an honest statement that templates were not interactive.

## Review output

Lead with findings ordered by driver impact.

- **P0**: can mislead a driver, leak data the policy says stays private, or blocks the primary task.
- **P1**: wrong claim, missing critical state, unreadable at large text, unusable with VoiceOver.
- **P2**: friction, inconsistency, weak hierarchy.
- **P3**: craft.

For each: file and line or rendered location, whether it was verified on a render, the rule or exemplar it cites, the user consequence and the smallest fix.

## Skill integrity

- Add or change a rule only after verifying the code, and record the evidence (a merged PR, a file, a test).
- Never promote one screenshot or one reviewer comment into a universal rule. If no standard exists, add it to `references/coverage-gaps.md`.
- Keep deterministic checks as code (`apps/mobile/test/theme-contrast.test.ts` for contrast, the site test and `check` script for the website). Keep judgement in prose.
