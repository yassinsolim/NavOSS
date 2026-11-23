<p align="center">
	<img src="apps/mobile/assets/images/icon.png" alt="NavOSS icon: a folded yellow navigation arrow on a teal background" width="128" height="128">
</p>

<h1 align="center">NavOSS</h1>

<p align="center">
	Account-free, privacy-first navigation for iPhone and CarPlay, built in the open, starting in Calgary.
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

NavOSS is an independently designed navigation app built on OpenStreetMap-derived data, MapLibre and Valhalla. There is no account or advertising. The default build has no analytics SDK; builds 80, 81, 82, 83, 84 and 85 include Google's Places SDK, whose privacy declarations are described in the policy. Search and routing use a self-hosted service in Alberta covering Canada; route matching, guidance and speech run on the phone. Fixed safety-camera alerts are a local Calgary overlay. The current milestone is an iPhone and CarPlay technical beta distributed through TestFlight. Android and coverage beyond Canada follow the iOS navigation and operations gates.

> [!WARNING]
> NavOSS is pre-release software. The service it talks to today has no live traffic and no production guarantee. Do not rely on it as your only source for navigation, closures, road rules or safety-camera information. Have a passenger operate the controls while a vehicle is moving.

## Status

This status distinguishes the deployed service from individual builds. Build availability must be confirmed in App Store Connect.

### TestFlight builds

The deployed `/v2/routes` service provides Canada-wide routing with lane and signpost data when returned.

Build `0.1.0 (85)` from `3b57b04` was distributed to internal testers and NavOSS Friends on 2026-11-23 with the `production-carplay-google` profile. App Store Connect showed Testing for both groups; no installs or sessions have been observed yet. With no destination set, CarPlay shows the guidance vehicle arrow or car at the live position, pointing the direction of travel, with the close guidance camera; panning pauses following and Recenter resumes it, and Go and End keep one marker. The phone's floating map controls take no taps while faded, their icon colours follow the basemap, and their glass backgrounds survive ending a trip. Android bring-up reaches iOS only through cached date and collation formatters. Release simulator validation was a go (551 native tests; the CarPlay free-drive captures were inspected), but its harness pixel gate for one free-drive capture failed twice and is judged a harness issue under investigation. Arrival time and "updated h:mm" use formatters created when the app starts, so a running app keeps its starting time zone until relaunch; this was reasoned from source, not seen on screen, and a fix is in progress in a separate PR. Real CarPlay chrome, a head unit or Apple's CarPlay Simulator, a physical iPhone, the signed build itself, the Maestro suite in this pass and an iPhone SE pass have not been verified. See the [release record](docs/release/testflight.md#build-85-validation-and-known-limits-2026-11-22) for validation and known limits.

Build `0.1.0 (84)` from `cf2afaa` was distributed to internal testers and NavOSS Friends on 2026-11-20 with the `production-carplay-google` profile. App Store Connect showed Testing for both groups, with no installs or sessions at that time. Its CarPlay showed no arrow when no destination was set (owner feedback; changed in build 85). It includes phone guidance status-bar and control changes, CarPlay card wording and arrow scale, offline-style checks, the dependency refresh and Maestro label fixes. Release simulator validation passed; real CarPlay chrome, a head unit, a physical iPhone, iOS 26.6.x and the signed build itself have not been verified. See the [release record](docs/release/testflight.md#build-84-validation-and-known-limits-2026-11-20) for validation and known limits.

Build `0.1.0 (83)` from `2cb5c70` was distributed to internal testers and NavOSS Friends on 2026-11-17 with the `production-carplay-google` profile. On 2026-11-20 it showed 4 installs and 3 sessions, with no new feedback. It includes the Share ETA / Share place sheet fix and CarPlay card, controls and map changes. The navigation harness passed; two Maestro flows failed on stale label checks fixed after the build commit. Real CarPlay chrome and iOS 26.6.1 hardware remain unverified. See the [release record](docs/release/testflight.md#build-83-build-82-feedback-validation-and-limits-2026-11-17) for known limits.

Build `0.1.0 (82)` from `65649ab` was distributed to internal testers and NavOSS Friends on 2026-11-15 with the `production-carplay-google` profile. It fixes repeated rerouting and lost route choice when starting away from the road, adds long-trip formatting on phone and CarPlay, and shows the year for event dates outside the current year. A Release simulator pass against production checked trip starts and phone long-trip text; CarPlay long-trip text has only Swift test and compile evidence.

Build 85 still ends a trip on relaunch if the app was closed before its first route match; PR #135 is parked. The Alberta events list can omit Edmonton rows from Calgary because only the 100 newest are shown; those events remain on the map. Alberta search rows show the city without the province. Repeated confirmed departures can trigger repeated reroutes without backoff. Changing the text size mid-trip clips the step list until relaunch.

Build 83's phone guidance can show a white status-bar clock on the light map and overlapping
controls when the trip sheet is expanded. Its CarPlay card can omit "Express" from "401 East",
repeat "Queen Elizabeth Way / QEW", and name a Montreal boulevard instead of the airport on the
sign. Build 84 includes changes addressing these. The offline CarPlay restyle was captured on a
simulator, not from build 84's own binary; automatic switching to the offline style if the hosted
style fails remains unverified. See the [build 84 checklist](docs/release/next-build-checklist.md#build-84-owner-checks)
for low findings and outstanding checks.

Build `0.1.0 (81)` from `14dae86` was processed by Apple and distributed to internal testers and NavOSS Friends on 2026-11-15, with the `production-carplay-google` profile. It adds the province-wide road-events list, Canada registry and route refusal presentation, plus the Explore-sheet fix. When a trip starts away from the road, it can reroute about every six seconds and replace the chosen alternative.

Builds 75 and 80 follow the server's declared coverage for search and routing; they can use the
Canada service too. This is based on their coverage and route-planner code, not a new on-screen test.

Build `0.1.0 (80)` from `141b394` (native contract v11, `production-carplay-google`) was distributed to internal testers and NavOSS Friends on 2026-11-15; it recorded one install and one session. It carries the App Attest entitlement and Google place panel. On the enabled production service, drivers can opt in to share road reports or traffic speeds; reports from verified installations appear unconfirmed until corroborated, while traffic is collected for evaluation and not displayed. Builds before 80 cannot share. As of 16:52 UTC on 2026-11-15, no installation had registered. Interactive CarPlay remains unverified on a head unit.

Build `0.1.0 (75)` from `d0594cd` (native contract v10) supports v2 routing, including lane guidance and signposts when returned, but cannot share reports or traffic.

Build `0.1.0 (70)` from `afa4067` (native contract v8, the phone UI before the refresh) uses the compatible v1 endpoints for Calgary and Kelowna:

| Area                 | What the build does                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map and search       | MapLibre map, place and address search, tappable places with OpenStreetMap details, Explore categories, saved and recent destinations (stored only on the device) |
| Routing and guidance | Route choices, avoid highways, native spoken turn-by-turn that continues with the phone locked, rerouting, arrival, ETA sharing through the system share sheet    |
| CarPlay              | Native CarPlay scene with search, route preview, Start/End, Dashboard, maneuvers, estimates and reconnect recovery                                                |
| Safety cameras       | Official City of Calgary intersection safety cameras with direction-aware alerts                                                                                  |
| Road reports         | The report button stores up to 25 two-hour private drafts on the device. Nothing is sent or shown to other drivers                                                |
| Not in this build    | Live traffic, lane guidance, signposts, shared road reports, offline maps, the refreshed phone UI, instrument-cluster and Siri route-preview support              |

### Build 75 and merged code

The features below are in uploaded build 75 unless otherwise noted.

| Area                           | State on `main`                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone UI refresh (#78)         | Design system (`src/theme`, `src/ui`), gesture bottom sheets, a decomposed map screen with controller hooks, light and dark, loading/empty/error/offline/location-denied states                                                                                              |
| Native contract v10 (#75, #84) | Indexed route matching, geometry-derived guidance, reroute consent modes, native camera alerts and speeding state, and `/v2/routes` step metadata. The client falls back to `/v1/routes` against a server that lacks `/v2/routes`                                            |
| CarPlay quality pass (#77)     | Course-up camera, drawn maneuver symbols, "then" guidance, optional lane guidance, faster search and voice recovery, reroute and camera alerts, instrument-cluster scene, Siri route preview. Not exercised on a head unit                                                   |
| Lanes and signposts (#84)      | Phone and CarPlay can show lanes and exit signs when the deployed v2 server returns them; build 75 uses v2. Interactive CarPlay is unverified on a head unit                                                                                                                 |
| Offline maps app side (#83)    | On-device offline maps, routing (Valhalla 3.9.1 via Rallista valhalla-mobile) and search are in build 75 onward; Alberta and Calgary-area bundles are live since 2026-11-15. A physical iPhone download in build 80 remains unverified. Privacy manifest declares Disk Space |
| Community client (#85)         | Native Swift client for community road reports and traffic, shared by phone and CarPlay, with App Attest and a JS bridge. Sharing is off by default. Build 80 carries the entitlement needed to share; build 75 cannot share.                                                |

### Deployed service

The production API image is from `36c8a9f`, deployed on 2026-11-15 with search and guidance-name fixes (#127); `navoss-api:pre-canada-search-fixes` is the image rollback tag. At 15:44 UTC that day the v2 service switched to Canada-wide search and routing and returns lane and signpost data when available; v1 remains compatible with build 70. Clients still degrade quietly when a server lacks a capability.

- **Canada coverage (#121):** all 13 provinces and territories declared; the Alberta+BC 22-directed-route matrix passed 22/22.
- **`/v2/routes` lanes and signposts (#79, #86):** the app's JS client planned Calgary to Banff with lane and signpost steps.
- **Community road reports (#73):** `attested`; build 80 onward may share; verified reports are unconfirmed until corroborated.
- **Community traffic (#76, #82, #86):** `collect`; opted-in speeds counted in memory for evaluation; nothing shown or used in routes.
- **Offline bundles (#80, #122):** published 2026-11-15 for All Alberta and Calgary, Airdrie, Cochrane & Okotoks; no BC region.
- **Province-wide road events (#120):** service returns Alberta, BC and Ontario events; the phone list is in distributed build 81, not builds 75 or 80. 511 Alberta and Ontario 511 were connected in production on 2026-11-15 and are included in build 81's list.

Remaining checks are in [the next-build checklist](docs/release/next-build-checklist.md).

## Architecture

```text
apps/mobile                        Expo + React Native iOS client
	src/theme, src/ui                Design tokens and primitives (colour roles, type, space, sheets)
	src/features/map                 One map screen; behaviour in controller/* hooks
	src/features/navigation          Guidance presentation; JS bridge to the native core
	modules/navoss-navigation        Native Swift core: matching, guidance, rerouting, speech,
	                                 routes client, community and traffic client (App Attest)
	carplay/ios                      CarPlay main, Dashboard and cluster scenes, App Intent
apps/api                           Fastify API: search, routing (v1 and v2), config, cameras,
                                   community reports, community traffic, offline manifest
apps/site                          Static website (CSP script-src 'none', no third-party requests)
packages/contracts                 Shared strict Zod contracts (coverage, routes, reports, traffic, offline)
infra                              Compose stack, Valhalla/Nominatim ops, offline bundle pipeline
docs                               Architecture, data provenance, privacy, tests, release evidence
.agents/skills/product-design      Product-design skill for agents (surfaces, copy rules, states)
```

- **Design system.** The phone UI uses role-based colour tokens for light and dark, a type scale, spacing, radii and motion in `apps/mobile/src/theme`, and shared primitives in `src/ui` (`Button`, `Banner`, `StateView`, `BottomSheet`, ...). Sheets are driven by one Reanimated value on the UI thread. Contrast is tested.
- **Controller hooks.** `map-screen.tsx` is a composition root; behaviour lives in `features/map/controller/*`. Camera frames never re-render the screen.
- **Native contract v10.** The Swift module owns location, matching, guidance, rerouting with consent modes, speech, camera eligibility and phone/CarPlay state. The phone and CarPlay are consumers. The routes client discovers `/v2/routes` through `/v2/config` and falls back to `/v1/routes`.
- **Community and traffic services.** Reports are structured, expiring and account-free, authenticated with Apple App Attest (`/v2/community/*`); verified reports are shown unconfirmed until corroborated. Opt-in traffic batches (`/v2/traffic/*`) are collected and counted in memory for evaluation, not published or used in routes. Both switches are off by default in the app; builds before 80 cannot share. Design: [community reports](docs/architecture/community-reports.md), [community traffic](docs/architecture/community-traffic.md).
- **Offline pipeline.** `infra/offline` builds checksummed regional PMTiles, Valhalla 3.9.1 graphs and SQLite search, described by a manifest. The app side (#83) is in build 75 onward; Alberta and Calgary-area bundles are hosted on Cloudflare R2 as of 2026-11-15.
- **Coverage follows the server.** The app names the coverage the server declares and never invents it.

The mobile client does not depend on provider-specific route models. Public Photon and FOSSGIS services are development dependencies only; release builds require a stable HTTPS API.

## Install

- **iPhone:** NavOSS is a TestFlight technical beta for invited testers; it is not on the App Store.
- **Android:** in testing. Signed APKs are attached to GitHub releases tagged `android-v<version>-<code>`, but none has been published yet; releases stay drafts until they have been tried on a device (the first draft, `android-v0.1.0-101`, is waiting for that). When one is published, download the APK from the [releases page](https://github.com/yassinsolim/NavOSS/releases), check its SHA-256 and signing certificate, and install it as described in [docs/release/android.md](docs/release/android.md). The app then offers newer releases itself, once a day (switchable off), and verifies each before Android installs it. Obtainium can also track the releases.

## Run it locally

Toolchain: Node.js 24.18.0 and pnpm 11.13.1 through Corepack (`mise.toml` pins both). The maintainer's Mac currently has Xcode 27.2; CI and release runners use Xcode 26.6. MapLibre needs the custom NavOSS development client; Expo Go cannot run this app.

```sh
corepack pnpm install --frozen-lockfile
```

Start the API on the mobile-development port (3000 may be taken):

```sh
HOST=0.0.0.0 PORT=3001 corepack pnpm --filter @navoss/api dev
```

Without a configuration the API uses the public FOSSGIS Valhalla and Photon development services and labels the result as degraded; point `VALHALLA_URL` and `PHOTON_URL` at self-hosted services to avoid that. Community reports and traffic need PostGIS, migrations (`node dist/migrate.js`), App Attest settings and, for the Simulator, `COMMUNITY_ATTESTATION_MODE=allow-development`; see [infra/compose/README.md](infra/compose/README.md).

Build and open the iOS development client, then use Metro for JavaScript-only changes:

```sh
corepack pnpm --filter @navoss/mobile ios
corepack pnpm --filter @navoss/mobile start:simulator
```

Notes that cost time:

- Xcode 27.2 has no CarPlay Simulator window, and Device Hub disables it for simulators. Interactive CarPlay cannot be run here. `corepack pnpm validate:navigation:ios --carplay-only` renders the production CarPlay map with a labelled mock of the template chrome.
- If the dev client cannot reach Metro, start Metro with `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1` and without `--localhost` (otherwise it can bind only to `::1`), and launch the app on its own instead of through the dev-client deep link.
- An active trip is restored on relaunch: end navigation first. Set the simulator location immediately before requesting a route.
- `apps/mobile/ios` is generated and ignored; change config, plugins, `carplay` or `modules`, then regenerate.

Device testing with a personal team, EAS profiles and the TestFlight pipeline are documented in [docs/development/macos-handoff.md](docs/development/macos-handoff.md), [docs/release/ci-cd.md](docs/release/ci-cd.md) and [docs/release/testflight.md](docs/release/testflight.md).

Useful API endpoints on a local server: `GET /health`, `GET /ready`, `GET /v1/config`, `GET /v2/config`, `POST /v1/search`, `POST /v1/routes`, `POST /v2/routes`, `GET /v1/cameras`, `GET /openapi.json`. Search and route requests are sent as JSON bodies, processed in memory and discarded; routine access logging is disabled.

## Quality gates

```sh
corepack pnpm check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm format:check
```

CI runs those five, plus a check that `THIRD_PARTY_NOTICES.md` is current, native Swift tests, CarPlay generated-source parity and scene declarations, and the **PostGIS suites** (community reports and traffic) against a `postgis/postgis:16-3.5-alpine` service with `NAVOSS_REQUIRE_TEST_DATABASE=1`, so they fail instead of silently skipping. Locally those suites skip when no database variable is set.

The read-only live search-quality harness uses the built API and contracts:
`corepack pnpm build && corepack pnpm --filter @navoss/api test:search:live`. Set
`NAVOSS_BASE_URL` to target another server. It checks all search categories at Calgary, Kelowna,
Toronto, Montreal, Halifax and Winnipeg, plus Ontario events, Toronto cameras and an
out-of-coverage search; requests start at least 550 ms apart. Failure output includes the query
and returned rows. Category checks use the API's display-label mapping; labels shared by multiple
OSM tags cannot identify the exact underlying tag.

The repaired harness (#128) ran against production on 2026-11-15: 738 requests, including 735 category queries at 21 locations; 673 returned results, 62 were empty and none failed.

For native navigation changes also run `corepack pnpm --filter @navoss/mobile test:native:ios` and a full Xcode compile. Maestro journeys and the iOS validation harness are listed in [apps/mobile/README.md](apps/mobile/README.md) and [docs/testing/navigation-validation.md](docs/testing/navigation-validation.md).

## Limitations

- **Coverage.** The deployed v2 service covers Canada; build 85 uses it. Build 70 uses v1 for Calgary and Kelowna. Some places have no connecting road route.
- **No live traffic or traffic-aware ETA.** Lane guidance and signposts appear only when returned by v2 and are unavailable in build 70.
- **Offline coverage.** All Alberta and the Calgary area can be downloaded in build 80. British Columbia has no offline region. A physical iPhone download in build 80 remains unverified.
- **CarPlay needs further head-unit validation.** The owner reported on build 82 in a car; build 85's real CarPlay chrome, head-unit appearance and free-drive arrow have not been seen on a car or Apple's CarPlay Simulator.
- **Android is in testing, not released.** The Android app has turn-by-turn guidance, speech and rerouting from the same navigation core as iOS, checked on emulators only: it has not run on a real device, with real GPS or in a car. It has no Android Auto, offline maps, report or traffic sharing, or Google place details. No Android release has been published; see [Install](#install).
- **Map matching** is geometric; it does not use road-network topology. Background guidance and spoken instructions still need sustained on-road evidence.
- **Data is incomplete.** OpenStreetMap, City of Calgary and DriveBC data can be missing, wrong or late; camera alerts are informational and do not replace signs and signals.
- **Single operator.** There is no staffed support, no service-level agreement and no direct support email yet.
- **External TestFlight is manual.** Build 85 was confirmed Testing for NavOSS Friends; a successful distribution request alone does not establish external availability or an installation.

## Contributing

Issues and focused pull requests are welcome while the technical-beta boundaries remain explicit.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, DCO sign-off, safety and data rules, and [AGENTS.md](AGENTS.md) for agent and maintainer conventions.
- Use the structured [issue forms](https://github.com/yassinsolim/NavOSS/issues/new/choose) for bugs, route-quality reports and proposals.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and [governance model](GOVERNANCE.md).

Never submit private addresses, personal trip traces, credentials, or map data copied from proprietary navigation products.

## More documentation

- [Privacy policy](docs/privacy.md), [data sources](docs/data-sources.md), [support page](docs/support.md)
- [TestFlight runbook](docs/release/testflight.md), [next-build checklist](docs/release/next-build-checklist.md), [App Store metadata](docs/release/app-store-metadata.md), [App Review readiness](docs/release/app-review.md)
- [CarPlay architecture](docs/architecture/carplay.md) and [feature parity](docs/testing/carplay-feature-parity.md)
- [Route-quality evidence](docs/testing/route-quality.md)

## Licensing and attribution

NavOSS uses a directory-based license split:

- `apps/mobile` and `packages/contracts`: MPL-2.0;
- `apps/api` and future hosted backend/operations/data-pipeline code: AGPL-3.0-only; and
- documentation and brand assets: all rights reserved unless stated otherwise.

See [LICENSE](LICENSE), [LICENSES/README.md](LICENSES/README.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OpenStreetMap, City of Calgary, DriveBC and other data keep their own licenses and attribution requirements; details are in [docs/data-sources.md](docs/data-sources.md).
