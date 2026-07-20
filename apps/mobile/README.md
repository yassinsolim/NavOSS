# NavOSS Mobile

The NavOSS mobile client is an Expo SDK 57 and React Native 0.86 application with MapLibre rendering and a local Swift navigation module. The first supported release target is iPhone; Android follows after the iOS navigation core is stable.

Expo Go cannot run this project because MapLibre and `NavOSSNavigation` require native code.

## Development

From the repository root, install dependencies and start the API on the dedicated mobile-development port:

```sh
corepack pnpm install --frozen-lockfile
HOST=0.0.0.0 PORT=3001 corepack pnpm --filter @navoss/api dev
```

Build the custom iOS development client:

```sh
corepack pnpm --filter @navoss/mobile ios
```

After the native client exists, JavaScript-only work can use:

```sh
corepack pnpm --filter @navoss/mobile start:simulator
```

## Validation

```sh
corepack pnpm --filter @navoss/mobile check
corepack pnpm --filter @navoss/mobile lint
corepack pnpm --filter @navoss/mobile test
corepack pnpm --filter @navoss/mobile test:native:ios
corepack pnpm --filter @navoss/mobile test:e2e:ios
```

The aggregate Maestro suite requires the API and Metro on port 3001 and 8081. It uses the dedicated `NavOSS iPhone 15 Pro Max` simulator and reboots it between flows to keep XCTest and simulated GPS reliable.

## Release Configuration

Production builds must receive a public HTTPS API origin:

```sh
EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app \
  corepack pnpm --filter @navoss/mobile validate:release
```

The validator rejects missing, HTTP, loopback, `.local`, and private-network origins. The planned hostname is not usable until the backend and DNS are live.

See the root [README](../../README.md), [TestFlight runbook](../../docs/release/testflight.md), and [CI/CD guide](../../docs/release/ci-cd.md) for the full workflow.
