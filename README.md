<p align="center">
	<img src="apps/mobile/assets/images/icon.png" alt="NavOSS upward chevron icon" width="128" height="128">
</p>

<h1 align="center">NavOSS</h1>

<p align="center">
	Account-free, privacy-first navigation built in the open, beginning with Calgary.
</p>

<p align="center">
	<a href="https://navoss.yassin.app">Project site</a> · <a href="https://github.com/yassinsolim/NavOSS/issues">Issues</a> · <a href="https://github.com/yassinsolim/NavOSS/discussions">Discussions</a>
</p>

<p align="center">
	<a href="https://github.com/yassinsolim/NavOSS/actions/workflows/ci.yml"><img src="https://github.com/yassinsolim/NavOSS/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
	<img src="https://img.shields.io/badge/iOS-technical_beta-1B2526" alt="iOS technical beta">
	<img src="https://img.shields.io/badge/mobile-MPL--2.0-18796F" alt="Mobile license: MPL-2.0">
	<img src="https://img.shields.io/badge/API-AGPL--3.0-E65342" alt="API license: AGPL-3.0-only">
</p>

NavOSS is an independently designed navigation project using OpenStreetMap-derived data, MapLibre, and Valhalla. The current milestone is a Calgary iPhone technical beta; Android and broader coverage come after the iOS navigation and operational gates are earned.

> [!WARNING]
> NavOSS is pre-release software. It has no live traffic or production service guarantee and must not be your only source for navigation, closures, road rules, or safety-camera information. Have a passenger operate controls while a vehicle is moving.

## Project Status

| Area               | Current state                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| iOS candidate      | Places, saved destinations, search, route choices, spoken background guidance, ETA sharing, arrival, CarPlay, and camera alerts |
| Native core        | Swift route ownership, course/continuity matching, rerouting, speech, recovery, and arrival hysteresis                          |
| API                | Public Fastify ingress with self-hosted Alberta Nominatim/Valhalla and Calgary camera data                                      |
| Automated evidence | Contract/API/mobile/site/Swift suites, simulator journeys, two iPhone layouts, and a 17-variant Calgary route matrix            |
| Current TestFlight | Build 13 is processed for internal testers; installation and physical validation remain                                         |
| Android            | Planned after the iOS navigation core is stable                                                                                 |

## Architecture

```text
apps/mobile                  Expo + React Native iOS/Android client
	modules/navoss-navigation Native Swift navigation core and Expo bridge
apps/api                     Fastify search, routing, config, and camera API
packages/contracts           Shared Zod request/response contracts
docs                         Architecture, data provenance, tests, and release evidence
```

The mobile client remains independent of provider-specific route models. Public Photon and FOSSGIS services are development dependencies only; release builds require a stable HTTPS API and production-capable search, routing, and tile services.

## Implemented

- Strict TypeScript pnpm/Turbo monorepo
- Shared Zod contracts for coordinates, coverage, health, readiness, problems, and search
- Fastify 5 API with Calgary-bounded OpenStreetMap search and deterministic fixture fallback
- Self-hosted Alberta Nominatim search and Valhalla routing behind provider-aware readiness checks
- Expo SDK 57 iOS development client with a full-screen MapLibre Calgary map
- Tappable rendered places with proximity-safe self-hosted OpenStreetMap details, Directions, Share, call/site actions, and an explicit external Reviews link
- Details-first destination flow with explicit Directions, ETA/distance, alternatives, route preview, Start, live maneuver banner, and End
- Privacy-minimal system-sheet place and ETA sharing without Contacts access, current coordinates, route geometry, or live tracking
- Persistent map presets and content controls, including green Day/Auto-light highway emphasis and restored Night/Minimal landmarks
- Native iOS background location, route projection, rerouting, spoken guidance, recovery, arrival, a map-matched puck, and a course-following MapLibre camera
- Dedicated CarPlay tester build with native search, route preview, Start/End, `CPNavigationSession`, maneuvers, travel estimates, and reconnect recovery
- All current official Calgary intersection-safety cameras on the map, with direction-safe route-ahead visual and spoken alerts
- Runtime request and response validation plus generated OpenAPI 3.1
- Search text/proximity sent in JSON POST bodies; routine access logging disabled and host logs bounded to seven days

## Local API

Use Node.js 24.18.0 and pnpm 11.13.0 through Corepack.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @navoss/api dev
```

The API binds to `127.0.0.1:3000` by default. Set `HOST` or `PORT` to override it.

- `GET /health`
- `GET /ready`
- `GET /v1/config`
- `GET /v1/cameras`
- `POST /v1/search` with a JSON body
- `POST /v1/routes`
- `GET /openapi.json`

Local development routes through Valhalla using OpenStreetMap data. The default is the public FOSSGIS development service and is visibly labeled as degraded in the app. Override it with a self-hosted endpoint:

```sh
VALHALLA_URL=http://127.0.0.1:8002/route HOST=0.0.0.0 PORT=3001 \
	corepack pnpm --filter @navoss/api dev
```

The public service is for development validation, not production. Selecting a destination sends the chosen origin and destination coordinates to the configured routing endpoint only when the user requests a route.

Place and address search uses the public Photon development endpoint by default and is restricted to the Calgary coverage bounds. Each search sends the entered text, English language preference, result limit, and, when location is available, approximate latitude/longitude to Photon. Photon continuously derives its results from OpenStreetMap. If Photon is unavailable, NavOSS falls back to deterministic Calgary fixtures and labels that fallback in the app.

Override Photon with a self-hosted endpoint by setting `PHOTON_URL`. The public endpoint is a fair-use development dependency with throttling and no availability guarantee; it is not suitable for production traffic or a claim of exhaustive address coverage.

Production uses `https://navoss-api.yassin.app` through an outbound Cloudflare Tunnel. Nominatim and Valhalla run on the operator-controlled Alberta VM and have no public ports. Search and route payloads are processed for each response and discarded; Caddy/Fastify access logging is disabled. The deployed route-quality gate passes all 17 Calgary variants with 73 ms p95 API latency.

Fixed red-light and speed-on-green camera locations come from The City of Calgary's monthly Intersection Safety Cameras dataset. The API validates and caches all current official records; the phone receives normalized public locations without sending user location to Calgary Open Data. Source details, terms, and alert safeguards are documented in [docs/data-sources.md](docs/data-sources.md).

## Navigation Status

The replacement candidate supports route geometry, ETA, distance, alternatives, avoid-highway routing, major-road summaries, selectable arrow/car markers, live maneuver distance, static ETA sharing, native rerouting, confirmed arrival, and explicit Start/End navigation. On iOS, `NavOSSNavigation` owns active Core Location, route geometry, map matching, progress, maneuver speech, rerouting, arrival, and transient recovery. React installs a route only after explicit Start and consumes versioned native snapshots. The module scores route candidates by distance, course alignment, and continuity with previously accepted progress; course is used only at 2 m/s or faster so stationary heading noise does not steer matching.

Accuracy-aware hysteresis confirms a departure after three credible off-route fixes and recovery after two precise on-route fixes. Native reroutes preserve destination and preferences, cancel stale work, and keep the existing route active when an update fails. Arrival requires two consecutive accurate endpoint fixes, at least 98% route progress, and an accuracy-adjusted destination distance within 30 meters. Camera alerts require route proximity, forward progress, and direction alignment, and each camera is announced at most once per trip.

This is still a technical beta, not full turn-by-turn parity. The geometric matcher does not yet use road-network topology or speed/time-based transition probabilities. Lane presentation, live traffic, traffic-aware ETA, offline routing, and community incident reports remain unavailable. Background guidance and spoken instructions are implemented but still require sustained on-road evidence.

## CarPlay

Apple approved the managed CarPlay Navigation App capability for `org.navoss.mobile` on 2026-07-21. CarPlay is a native scene in the same iPhone app rather than a second React Native screen. The dedicated `production-carplay` profile enables native search, route preview, Start/End, background progress, maneuvers, estimates, and reconnect continuity; normal builds omit the restricted scene and entitlement. Real wired/wireless CarPlay validation is still required. The similarly named deprecated macOS `com.apple.developer.maps` capability is unrelated and is not enabled.

Phone-side Share ETA uses the system share sheet and does not read Contacts. A custom recent-contacts browser is not an approved CarPlay navigation-template surface and will not be added; any future CarPlay sharing control remains gated on explicit template-compliance review.

The implementation boundary, entitlement gate, standard CarPlay flow, Dashboard support, cluster/HUD metadata, Expo prebuild strategy, and validation matrix are documented in [docs/architecture/carplay.md](docs/architecture/carplay.md).

## iOS Simulator

The local setup uses Xcode 26.6, iOS Simulator 26.5, CocoaPods 1.17.0, and Maestro 2.6.1. MapLibre requires the custom NavOSS development client; Expo Go cannot run this app.

Start the API on the dedicated mobile-development port:

```sh
HOST=0.0.0.0 PORT=3001 corepack pnpm --filter @navoss/api dev
```

In another terminal, build or reopen NavOSS in the iOS Simulator:

```sh
corepack pnpm --filter @navoss/mobile ios
```

After the first native build, JavaScript-only changes need only Metro:

```sh
corepack pnpm --filter @navoss/mobile start:simulator
```

Run the Calgary Tower simulator flow while the API and Metro are running:

```sh
corepack pnpm --filter @navoss/mobile test:e2e:ios
```

Start an Airport guidance session with the car marker and replay its route as interpolated simulator GPS updates:

```sh
corepack pnpm --filter @navoss/mobile test:simulate:ios
```

The replay streams every distinct Valhalla route vertex to Simulator so interpolation follows curves and ramps instead of cutting between a small sample of points. It defaults to 25 m/s. Set `NAVOSS_SIMULATION_SPEED_MPS` or `NAVOSS_SIMULATION_INTERVAL_SECONDS` to change playback. This validates foreground location progress and presentation only; it does not synthesize or validate live traffic.

## Physical iPhone

Local device testing does not require a paid Apple Developer membership. It does require Xcode signing with an Apple ID or Personal Team.

1. Connect the unlocked iPhone by USB-C and tap **Trust** on both devices if prompted.
2. On the iPhone, enable **Settings > Privacy & Security > Developer Mode**, restart, then confirm **Turn On**.
3. In Xcode, open **Settings > Accounts** and add the Apple ID used for local signing if it is not already present.
4. Open `apps/mobile/ios/NavOSS.xcworkspace`, select the NavOSS target, and choose your **Personal Team** under **Signing & Capabilities**. Keep **Automatically manage signing** enabled. This choice stays in the ignored local Xcode project and is not committed.
5. Keep the Mac and iPhone on the same Wi-Fi network. Start the API on `0.0.0.0:3001` as above.
6. Start Metro with the Mac's current LAN address:

```sh
EXPO_PUBLIC_API_URL="http://$(ipconfig getifaddr "$(route -n get default | awk '/interface:/ {print $2}')"):3001" \
	corepack pnpm --filter @navoss/mobile start -- --host lan
```

7. In another terminal, install NavOSS and select the connected iPhone when prompted:

```sh
corepack pnpm --filter @navoss/mobile ios:device
```

The development client loads its JavaScript bundle from Metro, so it stops working after the Mac is disconnected. A TestFlight build embeds that bundle and will not need Metro, but search and routing will still require a stable HTTPS API. A standalone beta therefore needs the regional API/Valhalla stack hosted or another explicitly approved temporary backend; embedding offline routing is a separate later milestone.

The API is intentionally exposed only for local development during this workflow. Stop both development servers when testing is finished.

## Beta release readiness

Build 12 remains the installed internal diagnostic build that supplied the latest feedback. The feedback-fixed build 13 is signed, audited, processed by Apple, and attached to the internal `testers` group; it still needs clean-device/background/real-CarPlay validation. The Canadian voice tuning added afterward requires a newer build before Beta App Review and external invites.

- [TestFlight beta runbook and GO/NO-GO gates](docs/release/testflight.md)
- [App Store Connect metadata draft](docs/release/app-store-metadata.md)
- [Calgary route-quality evidence and Apple/Google worksheet](docs/testing/route-quality.md)
- [Privacy policy draft](docs/privacy.md)
- [Support page draft](docs/support.md)
- [CI/CD and App Store delivery](docs/release/ci-cd.md)
- [Domain and service naming](docs/operations/domains.md)

## Quality Gates

```sh
corepack pnpm check
corepack pnpm lint
corepack pnpm test
corepack pnpm --filter @navoss/mobile test:native:ios
corepack pnpm --filter @navoss/mobile test:e2e:reroute:ios
corepack pnpm --filter @navoss/mobile test:e2e:arrival:ios
corepack pnpm --filter @navoss/mobile test:e2e:safety-cameras:ios
corepack pnpm --filter @navoss/api test:routes:live
EXPO_PUBLIC_API_URL=https://api.example.org corepack pnpm --filter @navoss/mobile validate:release
corepack pnpm build
corepack pnpm format:check
```

## Contributing

Issues and focused pull requests are welcome while the technical-beta boundaries remain explicit.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, DCO sign-off, safety, and data rules.
- Use the structured [issue forms](https://github.com/yassinsolim/NavOSS/issues/new/choose) for bugs, route-quality reports, and proposals.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and [governance model](GOVERNANCE.md).

Never submit private addresses, personal trip traces, credentials, or map data copied from proprietary navigation products.

## Licensing and Attribution

NavOSS uses a directory-based license split:

- `apps/mobile` and `packages/contracts`: MPL-2.0;
- `apps/api` and future hosted backend/operations/data-pipeline code: AGPL-3.0-only; and
- documentation and brand assets: all rights reserved unless stated otherwise.

See [LICENSE](LICENSE), [LICENSES/README.md](LICENSES/README.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OpenStreetMap and City of Calgary data retain their own licenses and attribution requirements; details are in [docs/data-sources.md](docs/data-sources.md).
