# Automated navigation validation

NavOSS provides one deterministic command for repeatable iOS navigation evidence:

```sh
corepack pnpm validate:navigation:ios
```

The command starts its own local API and Metro processes, rebuilds a CarPlay-enabled simulator app, reboots the dedicated simulator, runs phone and native scenarios, captures screenshots and logs, validates the images, writes a JSON result, and cleans up its child processes.

Artifacts are written to `artifacts/navigation-validation/` and preserved after both successful and failed runs.

## Prerequisites

- macOS with Xcode, an installed iOS Simulator runtime, CocoaPods, and Maestro;
- the repository's pinned Node and pnpm versions installed through mise or equivalent;
- the local API dependencies configured as described in the repository setup;
- ports 3001 and 8081 available for the API and Metro processes owned by the command.

The harness uses a dedicated simulator named `NavOSS iPhone 15 Pro Max`; create it in Xcode before the first run. The command does not depend on the currently selected Xcode simulator or a previously installed app.

## Modes

Use the complete validation before a release checkpoint:

```sh
corepack pnpm validate:navigation:ios
```

Use focused modes while debugging:

```sh
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --phone-only
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --carplay-only
```

After a successful build, add `--reuse-build` for fast iteration against the installed simulator app:

```sh
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --carplay-only --reuse-build
```

Build reuse is intentionally opt-in. The complete release command always regenerates and compiles the native project.

## Coverage

The phone suite validates:

- Calgary search and route preview;
- selected and alternate route presentation;
- active guidance, ETA, Share ETA, and End;
- all private road-report choices and safety copy;
- automatic rerouting after deterministic off-route movement;
- confirmed arrival after replaying the final route segment;
- screenshot decoding, nonblank content, OCR overlay detection, and uniqueness.

The native suite validates 48 navigation and CarPlay core behaviors, including trip lifecycle, stable publication, End controls, remaining-route geometry, route matching, rerouting, arrival, maneuver speech, destination persistence, API decoding, and driving-scale units.

The CarPlay visual suite mounts the exact production `NavOSSCarPlayMapViewController` in a simulator-only phone window and validates:

- selected route, alternate route, and destination preview;
- light and dark OpenFreeMap styles;
- matched arrow and forward camera at 5% progress;
- travelled-route removal at 60% progress;
- route cleanup;
- permission-overlay absence through Vision OCR;
- nonblank pixels, color diversity, luminance variance, unique hashes, and perceptual differences between scenarios.

The visual entrypoint is compiled only for Simulator and requires `NAVOSS_CARPLAY_VISUAL_SCENARIO`. It is absent from device builds and cannot be activated in TestFlight.

## Artifact layout

```text
artifacts/navigation-validation/
  environment.json
  summary.json
  logs/
  pixels/
    metrics.json
    sha256.json
  screenshots/
```

`summary.json` is the machine-readable source of truth. It includes the mode, timestamps, phase durations, failures, and final `passed` value. A failed command exits nonzero but preserves the full artifact directory.

## Limits

The simulator visual host verifies production map rendering and shared navigation state, not Apple's external CarPlay host, `CPMapTemplate` chrome, or vehicle-specific input behavior. Apple strips the managed CarPlay entitlement from ordinary simulator signatures on this machine.

Before broader distribution, still validate the signed TestFlight build on at least one wired and one wireless real CarPlay system. That manual check should focus on connection/reconnection, vehicle controls, search templates, route preview, Start, rerouting, arrival, persistent End controls, lock behavior, and phone synchronization. The automated harness is intended to make that final hardware check short and focused, not to pretend the hardware boundary does not exist.
