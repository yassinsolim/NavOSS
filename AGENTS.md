# NavOSS Agent Context

## Product and safety

- NavOSS is a privacy-first navigation technical beta for iOS and CarPlay. The deployed service covers Alberta and British Columbia; uploaded build 75 uses provincial `/v2/routes`, but tester availability is not yet confirmed (see Current checkpoint).
- Claim only what the **deployed** service and the relevant **build** do. Uploaded build 75 supports lane guidance and signposts when returned by the server; build 70 uses v1 for Calgary and Kelowna. Live traffic, community reports and offline maps are not available. Do not claim those capabilities in the app, the site, App Store metadata, or docs until they are enabled and validated.
- Never invent route, traffic, closure, camera, place, or safety data. Fail conservatively.
- Never log search text, route coordinates, raw location, or private trip history.
- Driving tests must be passenger-operated or performed while safely parked.
- Never touch the owner's physical iPhone, its signing identities, or its App Store Connect/TestFlight state except as the owner explicitly directs. Verify on simulators.
- AI agents must never run the raw beta-feedback redaction command or query raw contribution text,
  labels, draft IDs, or timestamps. Only aggregate counts and the human-approved deidentified inbox
  under `artifacts/feedback/approved/` may enter AI context. The workspace PreToolUse hook enforces
  this boundary.
- User-facing text about data collection must match `docs/privacy.md` (and `apps/site/src/privacy.html`). Change the policy in the same pull request as the behaviour.

## Product design

Any change to what a driver sees, hears, or is told (phone, CarPlay, spoken guidance, website, store text) loads the `product-design` skill at `.agents/skills/product-design/SKILL.md` first. It holds the request modes, the copy rules (honest capability claims, driving-safe wording, privacy copy), the states every surface must design (including the old-server state), the token and primitive inventory, and exemplars from merged PRs. Where no standard exists it points to `references/coverage-gaps.md`; record new gaps there instead of inventing rules.

## Architecture

- `apps/mobile`: Expo 57, React Native 0.86, MapLibre, and the native Swift navigation/CarPlay module.
  - `src/theme` (tokens) and `src/ui` (primitives, sheets) are the phone design system. `src/features/map` is the single map screen; behaviour lives in `features/map/controller/*` hooks and `map-screen.tsx` is a composition root. `src/features/navigation` presents guidance.
  - `modules/navoss-navigation` is the native core (`ios/Core`): navigation (matching, guidance, rerouting, speech, cameras), the CarPlay presentation helpers, the routes client (`/v2/routes` with `/v1/routes` fallback, discovered through `/v2/config`), and the community client (App Attest, reports, traffic uploader) with its JS bridge in `src/features/navigation/native-navigation.ts`.
  - `carplay/ios` holds the CarPlay scene delegates (main, Dashboard, instrument cluster), the map view controller, and the Siri/App Intent; `plugins/` copies them into the generated project.
- `apps/api`: Fastify API. The deployed API covers Alberta and British Columbia (`/v2/routes`, `/v2/config`); community reports (`/v2/community/*`, Apple App Attest, SQL migrations via `node dist/migrate.js`), community traffic (`/v2/traffic/*`) and offline maps are not available (see Current checkpoint).
- `packages/contracts`: shared strict Zod contracts, including the province registry (`coverage-data.ts`), `route-v2`, `community-report`, `traffic`, and `offline-bundle`.
- `infra/offline`: reproducible offline bundle pipeline (PMTiles, Valhalla 3.9.1 graphs, SQLite search). The app side (#83) is in uploaded build 75, but no bundles are hosted; the app says "Offline maps are not available yet" until a manifest is published. Do not describe offline maps as available until bundles are hosted and the feature is verified.
- `apps/site`: static website (`site.json` CSP with `script-src 'none'`, no third-party requests).
- Production API: `https://navoss-api.yassin.app`. Bundle ID: `org.navoss.mobile`.
- Native navigation contract **v11** (build 70 shipped v8; v9 added indexed matching, geometry guidance, reroute consent, native camera alerts, speeding state; v10 carries `/v2/routes` step metadata; v11 resumes a restored trip from saved progress and withholds its guidance behind `isAcquiringPosition` until a fix is matched, and refuses untimed live fixes) owns location, matching (windowed, grid-indexed, speed-plausible, with short dead reckoning), geometry-derived step progress, rerouting with consent modes (`adaptive`, `ask-first`, `keep-route`, whose rejoin is a `through` waypoint), speech, fixed-camera alert eligibility, speeding state, arrival, and phone/CarPlay state. The phone only presents camera alerts and reroute proposals.

## Toolchain and checks

- Use Node 24.18.0 and pnpm 11.13.1. `mise.toml` and `.node-version` pin Node; `packageManager` pins pnpm. System Node on the maintainer's Mac may be newer and lack Corepack; put a 24.18 toolchain first on `PATH`.
- Install with `corepack pnpm install --frozen-lockfile`.
- Before merging or releasing, run `corepack pnpm check`, `lint`, `test`, `build`, and `format:check`. CI also checks third-party notices (`licenses:generate` then no diff), the CarPlay splice control, `git diff --check`, native Swift tests, and CarPlay generated-source parity.
- CI runs the PostGIS suites (community reports and traffic) against a `postgis/postgis:16-3.5-alpine` service with `NAVOSS_REQUIRE_TEST_DATABASE=1`. Locally those suites skip without a database; set the three `NAVOSS_*TEST_DATABASE*` variables to run them.
- For native navigation changes, run `corepack pnpm --filter @navoss/mobile test:native:ios` and a full Xcode compile.
- The deterministic iOS harness is `corepack pnpm validate:navigation:ios`; it also supports `--phone-only`, `--carplay-only`, and opt-in `--reuse-build`.
- Local mobile development uses API port 3001 because port 3000 may be occupied.
- The maintainer's Mac currently has Xcode 27.2. It has no CarPlay Simulator window (Device Hub disables it for simulators), so interactive CarPlay cannot be exercised here. Hosted CI/release runners use Xcode 26.6.
- Dev-client tips that worked: start Metro with `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1` and without `--localhost` (otherwise it can bind only to `::1` and the dev client cannot connect); launch the installed app on its own instead of through the dev-client deep link; end any active trip first (an active trip is restored on relaunch); set the simulator location immediately before requesting a route. Rebuild the native client only after config, plugin, `carplay`, or module changes.

## Native and release constraints

- `apps/mobile/ios` is generated and ignored. Change Expo config, plugins, `apps/mobile/carplay`, or `apps/mobile/modules`, then regenerate; do not treat generated iOS files as source.
- Keep Apple Team IDs, credentials, certificates, provisioning profiles, tokens, and `.env` files local and out of Git.
- CarPlay requires the approved `com.apple.developer.carplay-maps` entitlement and the `production-carplay` EAS profile.
- App Attest: the entitlement is gated like CarPlay's. Only with `NAVOSS_APP_ATTEST_ENTITLEMENT_ENABLED=1` does the plugin write `com.apple.developer.devicecheck.appattest-environment` (from `NAVOSS_APP_ATTEST_ENVIRONMENT`: `production` for every EAS profile except `development`), the `NavOSSAppAttestEnabled` Info.plist switch and the build phase that fails a Release build with the development value. Since 2026-11-15 the App ID has the App Attest capability and the store profiles (`production`, `production-carplay`, `production-carplay-google`) set it `1`; the regenerated App Store provisioning profile is in EAS and hosted run `43674818814` signed build 76 with it (no upload). `development`, `preview` and `internal-carplay` stay `0` (their ad hoc profile was not regenerated). A build without the entitlement never uses App Attest: community writes stay "not supported" (reports private drafts, traffic sharing not available); build 75 is such a build. The Simulator software key is `#if DEBUG` only.
- Google place details are approved by the owner (2026-11-15) for the `production-carplay-google` build profile only: Google's Places UI Kit component renders live on the phone place sheet, the phone resolves the place's name and address to a Google place ID (Text Search, IDs only) and uses only that ID and Google's location for the place, in memory; nothing from Google is stored or sent to the server, and CarPlay shows no Google content. The default `production` and `production-carplay` profiles stay Google-disabled and keyless. The hosted TestFlight workflow takes `profile: production-carplay-google`; the key comes from the EAS `production` environment, never from GitHub.
- For local EAS iOS archives, unset `CC` and `CXX` so ExpoModulesJSI uses Apple Clang.
- Do not inspect or mutate an EAS local temporary build directory while Fastlane is compiling.

## Current checkpoint

- The latest uploaded build is `0.1.0 (75)` from `d0594cd` (`release/matcher-candidate-20261114`, native contract v10): hosted run `43670700742`, EAS submission `a2ffb73f-c94a-4242-9baa-b14bb63df587` finished 2026-11-15; Apple processing and tester availability are confirmed only in App Store Connect. It contains the revival through the matcher fix #100 and no App Attest entitlement. Build 70 (`afa4067`, contract v8) preceded it; build 73 was never uploaded and must never be retried; 74 was a no-upload preflight. Restore #102 (`b934040`), the topology dead-end mask #103 (`667d305`) and the traffic review fixes #104 (`8c88437`) are on `main` only, not in build 75. Community traffic stays `off`: live mode still needs the operator checklist in `docs/architecture/community-traffic.md`.
- External TestFlight distribution is manual since #88: an upload no longer assigns to `NavOSS Friends` or starts Beta App Review; a maintainer runs `testflight-distribute.yml` for a chosen build. EAS reads event-triggered workflows from the default branch; whether the old trigger is deregistered is unverified. The internal `testers` group receives uploads.
- **Production API deployed 2026-11-15:** commit `f780903`, image `navoss-api:latest` (`9001dda4444f`); rollback tag `navoss-api:pre-provincial-v2` (`351acadeaa57`). `/v1/config` remains strict v1; `/v2/config` declares Alberta and British Columbia and `/v2/routes`. The 22-directed-route matrix passed 22/22; the app's JS client planned Calgary to Banff over v2 with lanes and signposts. Build 75 uses v2; build 70 remains compatible with v1. Clients must still treat unknown `/v2/*` capabilities as quietly "not available", never an error or a claim.
- Community reports remain unavailable (`features.communityReports` false, publication `shadow`, no App Attest team id or installation secret); community traffic is `off`. The offline manifest returns 503 and no bundles are hosted. Calgary road events are live: `/v1/events` returned 200 with 149 events after the #93 fix. See `docs/release/next-build-checklist.md` for deployment evidence and remaining enablement steps.
- Interactive CarPlay is unverified end to end. A hosted-runner probe (GitHub Actions, simulator host) showed the entitled icon but crashed Apple's `CarPlayTemplateUIHost` on iOS 26.4 (`CPSTemplateInstance vehicleSupportsDestinationSharing` unrecognized selector) before Search appeared, and host screen capture failed on 26.5. All CarPlay verification is the harness (production map, mocked template chrome) plus native tests; a head unit is required (`docs/release/next-build-checklist.md`).
- Hosted CarPlay visuals run `43449279047` passed preflight, native tests, the simulator build, all 32 captures and pixel validation. This verifies the harness, not interactive head-unit operation.
- Build numbers and source commits must come from current EAS/App Store Connect evidence and `docs/release/testflight.md`, not from this file. Later source or test commits do not imply a new distributed binary.
- Release source of truth: `docs/release/testflight.md`; next build conditions: `docs/release/next-build-checklist.md`; CarPlay design and gaps: `docs/architecture/carplay.md`.

## Lessons that cost time in the revival

- **Tests written by the code's author share its assumptions.** Where an external convention exists (Apple App Attest, Valhalla, MapLibre, ECMAScript number formatting), test against independent vectors or the real thing: #85's assertion client data was proved with 97 vectors generated from the TypeScript helper; recorded real Valhalla and production responses are the route fixtures.
- **Mutation-check regression tests for security and privacy fixes.** Remove the fix, run the test, and confirm it fails (and say how many assertions fail). A test that still passes with the guard removed protects nothing (#87 found a per-cell race test that did).
- **Verify UI on the simulator, not from source.** The launch-tap bug, the Dynamic Type overflow, and the preview-camera bug in #78 were visible only on a render.
- **Archive ignored artifacts before removing a worktree.** `artifacts/` is gitignored; deleting a worktree deletes unpushed evidence and built bundles. Copy what matters out first.
- **Gate merges on the checks' own exit status.** Read the exit code or the CI conclusion of each gate; do not infer success from partial output, a cached run, or an earlier commit. Report what was run on the final commit.
- **UI tests exercise behaviour, not source text.** Do not write tests that grep source files; test the extracted logic (#78 replaced four such tests).
- **Compatibility is a test target.** A strict client schema rejected the deployed server's config in #84; test against the deployed server's real answers.
- **Merge `origin/main` into a branch before opening a PR and again before reporting done.** Never force-push.

## Git discipline

- Start work from an up-to-date `main` and use a focused branch for substantial changes.
- Do not commit ignored build output, generated iOS files, local evidence, secrets, or `.playwright-mcp/`.
- Keep commits focused and use Conventional Commit subjects.
- Sign off every commit as required by `CONTRIBUTING.md` using `git commit --signoff`.
- Never rewrite or discard user changes. Never force-push `main`.
- Record signed release artifacts and App Store Connect state in `docs/release/testflight.md` before declaring a release milestone complete.

## Immediate next work

1. Keep community reports, traffic and offline maps unavailable until their enablement steps in `docs/release/next-build-checklist.md` are completed. Clients must continue degrading quietly against servers without those capabilities.
2. Build 75 is uploaded; confirm it in App Store Connect and collect head-unit results. Cut the next build from `main`. App Privacy and App Attest provisioning remain prerequisites before enabling community sharing. Never retry build 73.
3. Record real head-unit outcomes against the CarPlay checklist when a build is available.
4. Run focused checks and the applicable release gates before publishing changes; record exact build and distribution state rather than inferring it from a successful upload.
