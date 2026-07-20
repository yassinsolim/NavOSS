# TestFlight beta runbook

Date: 2026-07-19

## Current verdict

| Stage                                     | Verdict             | Reason                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local simulator and physical-device alpha | GO                  | Core, API, mobile, native, route-matrix, reroute, arrival, camera, and privacy-sheet checks pass.                                                                                                                                                     |
| Metro-independent iOS Release archive     | GO, structural only | An unsigned arm64 `0.1.0 (1)` archive succeeded with an embedded bundle, injected HTTPS origin, privacy manifests, compiled icons, foreground-only location, and no localhost/local-network keys. The test origin was reserved and is not deployable. |
| Internal TestFlight                       | NO-GO               | A real public backend, Apple distribution setup, public privacy/support URLs, and a signed uploaded build are missing.                                                                                                                                |
| External TestFlight                       | NO-GO               | Internal soak, Beta App Review metadata, on-road evidence, support operations, and the internal blockers are incomplete.                                                                                                                              |
| Public App Store                          | NO-GO               | Background guidance, spoken maneuvers, traffic-aware ETA, production service operations, and broader safety/quality evidence remain incomplete.                                                                                                       |

The right next launch is a small **internal TestFlight technical beta**, not a public navigation release.

## Blocking requirements

### P0: required before any TestFlight invite

- Deploy a stable public HTTPS NavOSS API. It must use production-capable Valhalla, search, map-tile, and camera dependencies. Public Photon and FOSSGIS endpoints are development-only.
- Keep request bodies and query strings out of logs. Decide and document IP/security-log retention before publishing the privacy policy.
- Enroll in the Apple Developer Program, create the App Store Connect app for `org.navoss.mobile`, and establish App Store distribution signing. This Mac currently has only an Apple Development identity.
- Publish `https://navoss.yassin.app/privacy` and `https://navoss.yassin.app/support`, then verify them without authentication.
- Activate and test `navoss@yassin.app` forwarding, and make the cleaned source repository public before marketing NavOSS as open source.
- Replace every `REQUIRED` field in `docs/release/app-store-metadata.md`, `docs/privacy.md`, and `docs/support.md`.
- Reconcile the app privacy manifest and App Store Connect label with the final providers and retention. The current manifest declares no collected data; that is valid only if search/location data is discarded immediately after servicing each request under Apple's definition.
- Produce build 1 with the real API URL, upload it, install it from TestFlight, disconnect Metro/the Mac, and repeat the physical-device smoke test.

### P1: required before external testers

- Run at least a 24-hour backend soak with readiness monitoring, TLS renewal monitoring, latency/error alerts, and a rollback procedure.
- Complete the manual Apple/Google worksheet in `docs/testing/route-quality.md`; investigate every safety, legality, endpoint, or major road-choice discrepancy.
- Run passenger-operated on-road tests across downtown, Deerfoot Trail, Stoney Trail, complex interchanges, weak-GPS areas, destination arrival, rerouting, and camera approaches.
- Add crash diagnostics or document the privacy-preserving alternative and support triage process.
- Confirm map/search/routing data attribution and production usage rights in the shipped UI and hosted legal pages.
- Verify the app remains usable for the stated beta scope when the screen locks or clearly constrain the beta to foreground, screen-on testing. Current guidance is foreground-only.

## Backend release gate

Set the final origin and run:

```sh
EXPO_PUBLIC_API_URL=https://api.example.org \
  corepack pnpm --filter @navoss/mobile validate:release
```

The validator rejects missing, non-HTTPS, loopback, `.local`, and private-network origins. Replace `https://api.example.org` with the real deployment.

Before creating a build, verify:

```sh
curl --fail https://api.example.org/health
curl --fail https://api.example.org/ready
curl --fail https://api.example.org/v1/config
```

Run a release export to prove the JavaScript bundle embeds the backend origin:

```sh
EXPO_PUBLIC_API_URL=https://api.example.org \
  corepack pnpm --filter @navoss/mobile build:release
```

## Apple setup

1. Enroll the legal owner in the Apple Developer Program and accept current agreements.
2. In Certificates, Identifiers & Profiles, register the explicit App ID `org.navoss.mobile` if it does not already exist.
3. In App Store Connect, create a new iOS app named NavOSS with that bundle ID, primary language, SKU, and user-access scope.
4. Set version `0.1.0`; increment the build number for every upload.
5. Configure App Privacy, age rating, category, privacy-policy URL, support URL, review contact, and copyright using the metadata draft.
6. Create or allow Xcode/EAS to manage an Apple Distribution certificate and App Store provisioning profile.
7. Answer export-compliance questions accurately. The app currently declares `ITSAppUsesNonExemptEncryption: false` because it uses standard HTTPS and no custom encryption; the legal owner must confirm that classification before upload.

## Archive and upload

With local Xcode signing configured:

1. Open `apps/mobile/ios/NavOSS.xcworkspace` in Xcode.
2. Select the NavOSS scheme and **Any iOS Device**.
3. Provide `EXPO_PUBLIC_API_URL` to the Release archive environment.
4. Choose **Product > Archive**.
5. In Organizer, choose **Distribute App > App Store Connect > Upload**.
6. Resolve every validation warning; do not upload an archive containing a reserved, localhost, LAN, or development-provider URL.

Native Release compilation has already been exercised with signing disabled. The resulting arm64 archive used bundle ID `org.navoss.mobile`, version `0.1.0 (1)`, and a 3.0 MB embedded JavaScript bundle. It is intentionally not uploadable: this Mac currently has an Apple Development identity only, not the Apple Distribution certificate/profile required by App Store Connect.

An EAS Build workflow is also configured in `apps/mobile/eas.json`, but the app has not yet been linked to an Expo/EAS project. Do not invent a project ID. From `apps/mobile`, the owner should authenticate and run `eas init`, store `EXPO_PUBLIC_API_URL` in the production EAS environment, and add the resulting real project ID to app configuration. The mobile package runs the release validator in EAS's pre-install hook.

The `preview` profile is an ad hoc production-like build, not TestFlight. Use the `production` profile for a store-signed build:

```sh
eas build --platform ios --profile production
eas submit --platform ios --profile production
```

After App Store Connect creates the app, add its numeric Apple ID as `submit.production.ios.ascAppId` or let EAS prompt during the first submission.

## Internal TestFlight

1. Wait for Apple to process the uploaded build.
2. Complete encryption/export-compliance prompts and verify the processed build details.
3. Create an internal group with only App Store Connect users who are actively testing.
4. Add build 1, paste the beta description and What to Test text, and invite the smallest useful group first.
5. Install from TestFlight on a clean iPhone. Confirm the app starts without Metro, reaches the production API, requests only foreground location, searches, routes, reroutes, arrives, displays all current cameras, and submits TestFlight feedback.
6. Soak for 48 hours before adding more testers. Stop rollout on crashes, invalid routes, stale closures, backend saturation, or misleading camera alerts.

Apple permits up to 100 internal testers associated with App Store Connect. Builds expire after 90 days.

## External TestFlight

After the internal gate passes:

1. Create an external group.
2. Complete Test Information, including beta description, feedback email, privacy-policy URL, and What to Test.
3. Add the tested build and submit it for Beta App Review.
4. Start with a small named cohort; do not begin with a public link.
5. Expand only after service and route-quality thresholds remain stable.

Apple permits up to 10,000 external testers, subject to Beta App Review.

## Public App Store gate

Do not submit the current technical beta as a full navigation replacement. Before public release, NavOSS needs reliable background guidance, spoken turn instructions, production map/search/routing operations, explicit traffic limitations or a traffic feed, wider route and on-road coverage, support response targets, and completed privacy/legal review.

## Apple references

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds-overview/)
- [Manage App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Submit for App Review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)
