# NavOSS

NavOSS is a privacy-first, open-source navigation project beginning with a Calgary technical alpha.

## Implemented

- Strict TypeScript pnpm/Turbo monorepo
- Shared Zod contracts for coordinates, coverage, health, readiness, problems, and search
- Fastify 5 API with Calgary-bounded OpenStreetMap search and deterministic fixture fallback
- Expo SDK 57 iOS development client with a full-screen MapLibre Calgary map
- Frictionless destination flow: search, automatic route calculation, ETA/distance, alternatives, route preview, Start, live maneuver banner, and End
- Foreground GPS progress with a course-following MapLibre camera and explicit development/degraded source labels
- Runtime request and response validation plus generated OpenAPI 3.1
- Automatic request logging disabled so queries and coordinates are not written to logs

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
- `GET /v1/search?q=calgary+tower`
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

## Navigation Status

The current technical-alpha slice supports route geometry, ETA, distance, available alternatives, avoid-highway routing, major-road summaries, a selectable arrow/car marker, written guidance, foreground GPS progress, and Start/End navigation. It explicitly reports that live traffic is unavailable and does not claim production turn-by-turn parity. The active puck currently displays raw location updates rather than a map-matched location. Off-route detection and rerouting, background guidance, spoken instructions, lane presentation, route snapping, traffic-aware ETA, and arrival handling remain gated on the native navigation-core spike and local Valhalla deployment.

## CarPlay

CarPlay navigation is feasible, but it must be a native scene in the same iPhone app rather than a second React Native screen. Apple must approve the managed `com.apple.developer.carplay-maps` capability before NavOSS can enable and provision it. The native navigation core must become the source of truth for route progress before CarPlay can work reliably while the phone is locked.

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

The API is intentionally exposed only for local development during this workflow. Stop both development servers when testing is finished.

## Quality Gates

```sh
corepack pnpm check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm format:check
```
