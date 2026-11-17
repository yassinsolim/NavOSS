# NavOSS Agent Context

## Product and safety

- NavOSS is a privacy-first navigation technical beta for iOS and CarPlay. The deployed search and routing service covers Canada; build 82 was distributed to internal testers and NavOSS Friends on 2026-11-15 (see Current checkpoint).
- Claim only what the **deployed** service and the relevant **build** do. Build 80 supports lane guidance and signposts when returned by the server; build 70 uses v1 for Calgary and Kelowna. Reports are `attested` and opt-in traffic collection is `collect`: build 80 onward can share, earlier builds cannot. Reports from verified installations are unconfirmed until corroborated. Collected traffic is not displayed or used in routes; live traffic is unavailable. Offline regions for Alberta and the Calgary area are available; British Columbia has none.
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
- `apps/api`: Fastify API. The deployed API covers Canada for search and routing (`/v2/routes`, `/v2/config`); community reports (`/v2/community/*`, Apple App Attest, SQL migrations via `node dist/migrate.js`) and traffic collection (`/v2/traffic/*`) are enabled. Live traffic is unavailable (see Current checkpoint).
- `packages/contracts`: shared strict Zod contracts, including the province registry (`coverage-data.ts`), `route-v2`, `community-report`, `traffic`, and `offline-bundle`.
- `infra/offline`: reproducible offline bundle pipeline (PMTiles, Valhalla 3.9.1 graphs, SQLite search). The app side (#83) is in build 75 onward; on 2026-11-15 the production manifest began serving All Alberta and Calgary-area bundles hosted on Cloudflare R2. A Debug simulator downloaded Calgary and searched and routed with the API stopped; a build 80 download on a physical iPhone remains unverified. BC has no offline region.
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
- Google place details are approved by the owner (2026-11-15) for the `production-carplay-google` build profile only: Google's Places UI Kit component renders live on the phone place sheet, only Places UI Kit components are used (Places API web services such as Text Search are Core Services Google's terms forbid next to a non-Google map); the automatic panel is Google's listing nearest the coordinate, shown within 30 m, with "Find this place on Google" (Place Search) as the correction; nothing from Google is stored or sent to the server, and CarPlay shows no Google content. The default `production` and `production-carplay` profiles stay Google-disabled and keyless. The hosted TestFlight workflow takes `profile: production-carplay-google`; the key comes from the EAS `production` environment, never from GitHub.
- For local EAS iOS archives, unset `CC` and `CXX` so ExpoModulesJSI uses Apple Clang.
- Do not inspect or mutate an EAS local temporary build directory while Fastlane is compiling.

## Current checkpoint

- The latest distributed build is `0.1.0 (82)` from `65649ab` (`main`, profile `production-carplay-google`): hosted run `43771911635`, EAS submission `a5de686e-b166-47f7-b5b0-237f6775ff3b` finished 2026-11-15 23:13 UTC. Signature and Google Places linkage were verified. At 23:18 UTC it was distributed to internal `testers` and NavOSS Friends; App Store Connect shows Testing for both. It includes #133 trip-start fix, #127 phone and CarPlay long-trip formatting, and #134 event-date years. Build 73 remains held.
- Build 81 can reroute about every six seconds and replace the selected alternative when a trip starts away from the road. Build 82 fixes this but still ends a trip on relaunch if closed before its first route match; #135 is in review. The Alberta events list can omit Edmonton rows from Calgary because it shows the 100 newest; those events remain on the map. Alberta search rows omit the province. Repeated confirmed departures can trigger repeated reroutes without backoff.
- External TestFlight distribution is manual since #88: an upload no longer assigns to `NavOSS Friends` or starts Beta App Review; a maintainer runs `testflight-distribute.yml` for a chosen build. EAS reads event-triggered workflows from the default branch; whether the old trigger is deregistered is unverified. The internal `testers` group receives uploads.
- **Canada cutover 2026-11-15 15:44 UTC:** API image was `4708d34`, with image rollback `navoss-api:pre-canada-registry` and data backup `.env.pre-canada-20261115T154413Z`. The current API image is from `36c8a9f` (#127), deployed 2026-11-15; its image rollback is `navoss-api:pre-canada-search-fixes`. `/v1/config` remains strict v1; `/v2/config` declares all 13 provinces and territories as Canada. Clients must still treat unknown `/v2/*` capabilities quietly.
- Reports are `attested` and traffic is `collect`; live traffic is unavailable. Province-wide `/v2/events` serves Alberta, BC and Ontario; the phone list is in distributed build 81, not builds 75 or 80. 511 Alberta and Ontario 511 were connected in production on 2026-11-15, so build 81's list includes their events. Offline regions remain Alberta and Calgary only.
- Interactive CarPlay is unverified end to end. A hosted-runner probe (GitHub Actions, simulator host) showed the entitled icon but crashed Apple's `CarPlayTemplateUIHost` on iOS 26.4 (`CPSTemplateInstance vehicleSupportsDestinationSharing` unrecognized selector) before Search appeared, and host screen capture failed on 26.5. The owner reported on build 82 in a car on 2026-11-16; the subsequent changes have harness (production map, mocked template chrome), Apple-layout probe and native-test evidence, not a real head-unit pass (`docs/release/next-build-checklist.md`).
- Hosted CarPlay visuals run `43449279047` passed all 32 captures and pixel validation. Nightly run `43733475080` failed twice on 2026-11-15 when simulator boot status timed out after 120 seconds, after the app built and native tests passed; the same harness passed locally twice that day. Cause is unestablished. Neither result verifies interactive head-unit operation.
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

1. After #135 is reviewed and merged, prepare build 83. Build 82's long-trip text was seen on the phone simulator; its CarPlay formatter was compiled and Swift-tested but not seen on screen. Keep live traffic unavailable and degrade quietly against servers without capabilities.
2. Perform first physical iPhone checks for every build since 80, including offline download, first App Attest registration and Google's place panel. Never retry build 73.
3. Record real head-unit outcomes against the CarPlay checklist; interactive CarPlay remains unverified.
4. Run focused checks and the applicable release gates before publishing changes; record exact build and distribution state rather than inferring it from a successful upload.
