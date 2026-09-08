# NavOSS Agent Context

## Product and safety

- NavOSS is a privacy-first navigation technical beta, currently focused on Calgary and iOS/CarPlay.
- Do not claim live traffic, traffic-aware ETA, lane guidance, offline routing, public incident crowdsourcing, or production-service guarantees unless those capabilities are actually added and validated.
- Never invent route, traffic, closure, camera, place, or safety data. Fail conservatively.
- Never log search text, route coordinates, raw location, or private trip history.
- Driving tests must be passenger-operated or performed while safely parked.
- AI agents must never run the raw beta-feedback redaction command or query raw contribution text,
  labels, draft IDs, or timestamps. Only aggregate counts and the human-approved deidentified inbox
  under `artifacts/feedback/approved/` may enter AI context. The workspace PreToolUse hook enforces
  this boundary.

## Architecture

- `apps/mobile`: Expo 57, React Native 0.86, MapLibre, and the native Swift navigation/CarPlay module.
- `apps/api`: Fastify API backed in production by self-hosted Alberta Nominatim, Valhalla, and Calgary camera data.
- `packages/contracts`: shared strict Zod contracts.
- Production API: `https://navoss-api.yassin.app`.
- Bundle ID: `org.navoss.mobile`.
- Native navigation contract v8 owns location, matching, progress, rerouting, speech, camera alerts, arrival, and phone/CarPlay state.

## Toolchain and checks

- Use Node 24.18.0 and pnpm 11.13.0. `mise.toml` pins both.
- Install with `corepack pnpm install --frozen-lockfile`.
- Before merging or releasing, run `corepack pnpm check`, `lint`, `test`, `build`, and `format:check`.
- For native navigation changes, run `corepack pnpm --filter @navoss/mobile test:native:ios` and a full Xcode compile.
- The deterministic iOS harness is `corepack pnpm validate:navigation:ios`; it also supports `--phone-only`, `--carplay-only`, and opt-in `--reuse-build`.
- Local mobile development uses API port 3001 because port 3000 may be occupied.

## Native and release constraints

- `apps/mobile/ios` is generated and ignored. Change Expo config, plugins, `apps/mobile/carplay`, or `apps/mobile/modules`, then regenerate; do not treat generated iOS files as source.
- Keep Apple Team IDs, credentials, certificates, provisioning profiles, tokens, and `.env` files local and out of Git.
- CarPlay requires the approved `com.apple.developer.carplay-maps` entitlement and the `production-carplay` EAS profile.
- Checked-in production profiles keep Google Places disabled. Do not enable Google without explicit approval, billing/key setup, and matching privacy disclosures.
- For local EAS iOS archives, unset `CC` and `CXX` so ExpoModulesJSI uses Apple Clang.
- Do not inspect or mutate an EAS local temporary build directory while Fastlane is compiling.

## Current checkpoint

- The latest recorded TestFlight candidate is `0.1.0 (54)` from `78e3aaa` (PR #34), with EAS build and submission both `FINISHED` on 2026-09-06. Submission completion alone does not establish Apple processing, tester-group distribution, or automatic installation.
- Build 54 binds the CarPlay vehicle render loop to the car display and adds road-following position and corner-heading interpolation. Build 53 fixed the blank phone companion screen, but its tester feedback confirmed that the screen-off freeze remained.
- Physical head-unit validation of build 54's locked-phone movement, turning, and reconnect behavior remains unconfirmed. Do not treat simulator map-host checks as that validation.
- Build numbers and source commits must come from current EAS/App Store Connect evidence and `docs/release/testflight.md`, not from an old checkpoint. Later source or test commits do not imply a new distributed binary.
- The release source of truth is `docs/release/testflight.md`; CarPlay design and remaining gaps are in `docs/architecture/carplay.md`.

## Git discipline

- Start work from an up-to-date `main` and use a focused branch for substantial changes.
- Do not commit ignored build output, generated iOS files, local evidence, secrets, or `.playwright-mcp/`.
- Keep commits focused and use Conventional Commit subjects.
- Sign off every commit as required by `CONTRIBUTING.md` using `git commit --signoff`.
- Never rewrite or discard user changes. Never force-push `main`.
- Record signed release artifacts and App Store Connect state in `docs/release/testflight.md` before declaring a release milestone complete.

## Immediate next work

1. Replace generic search-result “Point of interest” labels with concise, factual place descriptions drawn from available provider data.
2. Connect the existing build/submission workflow to TestFlight distribution for the established tester groups; distinguish Apple approval and group availability from testers' automatic-update settings.
3. Preserve the locked-phone CarPlay verification checklist and record real head-unit outcomes when available.
4. Run focused checks and the applicable release gates before publishing changes; record the exact build and distribution state rather than inferring it from a successful upload.
