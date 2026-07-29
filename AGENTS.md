# NavOSS Agent Context

## Product and safety

- NavOSS is a privacy-first navigation technical beta, currently focused on Calgary and iOS/CarPlay.
- Do not claim live traffic, traffic-aware ETA, lane guidance, offline routing, public incident crowdsourcing, or production-service guarantees unless those capabilities are actually added and validated.
- Never invent route, traffic, closure, camera, place, or safety data. Fail conservatively.
- Never log search text, route coordinates, raw location, or private trip history.
- Driving tests must be passenger-operated or performed while safely parked.

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

- `main` contains complete CarPlay controls at `a5e1f5d` and its release record at `a3cbb5e`.
- Build `0.1.0 (26)` was signed, audited, and uploaded. Apple processing, internal `testers` attachment, and physical head-unit validation are still pending.
- Build 26 adds parked Search, Settings, Automatic/Light/Dark appearance, All guidance/Alerts only/Muted audio, active End/overview/report controls, and private bounded two-hour report drafts.
- Build 26 IPA SHA-256: `c59f1e40669c9f93ec17a1e7debdcaceca47fa6fd3153afe7be6d26574074950`.
- EAS submission: `a8d7e2de-a355-46d9-acc5-889cff6517f9`.
- The detailed release source of truth is `docs/release/testflight.md`; CarPlay design and remaining gaps are in `docs/architecture/carplay.md`.

## Git discipline

- Start work from an up-to-date `main` and use a focused branch for substantial changes.
- Do not commit ignored build output, generated iOS files, local evidence, secrets, or `.playwright-mcp/`.
- Keep commits focused and use Conventional Commit subjects.
- Sign off every commit as required by `CONTRIBUTING.md` using `git commit --signoff`.
- Never rewrite or discard user changes. Never force-push `main`.
- Record signed release artifacts and App Store Connect state in `docs/release/testflight.md` before declaring a release milestone complete.

## Immediate next work

1. Confirm build 26 is processed in App Store Connect and attach it to internal group `testers`.
2. Save focused What to Test notes for parked Search, appearance, audio modes, reports, End, overview/follow, arrow direction, and reconnect behavior.
3. Install build 26 and validate it on a real wired or wireless CarPlay head unit while parked or passenger-operated.
4. Update `docs/release/testflight.md`, run focused checks, commit with signoff, and push the confirmed state.
