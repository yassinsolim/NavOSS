# TestFlight beta runbook

Date: 2026-07-22

## Current verdict

| Stage                                     | Verdict | Reason                                                                                                                                                                                                   |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local simulator and physical-device alpha | GO      | Core, API, mobile, native, route-matrix, places, ETA sharing, reroute, arrival, camera, privacy-sheet, and compact-screen checks pass.                                                                   |
| Metro-independent iOS Release export      | GO      | A July 22 Hermes export embeds `https://navoss-api.yassin.app`; no retired, loopback, or LAN NavOSS API origin is present. Framework-only Expo localhost fallbacks are not used by the release API path. |
| Internal TestFlight                       | NO-GO   | Audited build `0.1.0 (10)` is uploaded to App Store Connect. Apple processing, App Privacy/provider classification, owner questionnaires, and a clean-device build 10 smoke test remain.                 |
| External TestFlight                       | NO-GO   | Internal soak, reviewer-accessible Calgary route planning, Beta App Review metadata, on-road evidence, support operations, and the internal blockers are incomplete.                                     |
| Public App Store                          | NO-GO   | Physical-device background/CarPlay evidence, traffic-aware ETA, production service operations, and broader safety/quality evidence remain incomplete.                                                    |

The right next launch is a small **internal TestFlight technical beta**, not a public navigation release.

## Blocking requirements

### P0: required before any TestFlight invite

- [x] Deploy `https://navoss-api.yassin.app` with self-hosted Alberta Valhalla/Nominatim, indexed Calgary business/parcel search, public OpenFreeMap rendering, and official Calgary camera data.
- [x] Send search in a JSON POST body; disable routine access logging; enforce seven-day host logs and 14-day report-database backups; publish the verified policy.
- [x] Configure App Store Connect app `NavOSS`, Apple ID `6792619727`, EAS production origin, distribution certificate, provisioning profile, and Submit ID.
- [x] Verify the public privacy/support URLs and the Metro-independent production export.
- [x] Validate matched-road heading-up navigation, persistent north-up compass override, local-only map presets/content controls, and route-color choices in the iOS simulator.
- [x] Build and upload store-signed `0.1.0 (6)` from commit `71f0003` through EAS; Apple accepted the binary for processing.
- [x] Build and upload `0.1.0 (7)` with dropped-pin routing and `0.1.0 (8)` with corrected map presets/landmarks; Apple accepted both binaries.
- [x] Deploy place-detail API commit `96ca37a`, pass all 17 production route cases, and verify detail request payloads remain absent from logs.
- [x] Build, audit, and upload `0.1.0 (10)` from compact-screen commit `ee10974`; build 9 was deliberately not submitted after simulator review found a truncated arrival value.
- [ ] Classify Cloudflare/OpenFreeMap map and network metadata, then reconcile App Store Connect App Privacy, `PrivacyInfo.xcprivacy`, SDK manifests, and the hosted policy.
- [ ] Complete the account-holder age-rating, content-rights, and export-compliance decisions.
- [ ] Install build 10 from TestFlight after processing, disconnect Metro/the Mac, and repeat the physical-device smoke test.

### P1: required before external testers

- Run at least a 24-hour backend soak with readiness monitoring, TLS renewal monitoring, latency/error alerts, and a rollback procedure.
- Complete the manual Apple/Google worksheet in `docs/testing/route-quality.md`; investigate every safety, legality, endpoint, or major road-choice discrepancy.
- Run passenger-operated on-road tests across downtown, Deerfoot Trail, Stoney Trail, complex interchanges, weak-GPS areas, destination arrival, rerouting, and camera approaches.
- Add crash diagnostics or document the privacy-preserving alternative and support triage process.
- Confirm map/search/routing data attribution and production usage rights in the shipped UI and hosted legal pages.
- Add manual Calgary origin selection or a clearly visible route-preview path so Beta App Review can exercise routing from outside Calgary.
- Activate and externally test `navoss@yassin.app` delivery and reply handling.
- Verify active guidance, speech, rerouting, arrival, and End cleanup while the screen is locked. For the CarPlay profile, repeat the flow on wired and wireless systems and confirm the minimal phone companion remains non-distracting.

## Backend release gate

Set the final origin and run:

```sh
EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app \
  corepack pnpm --filter @navoss/mobile validate:release
```

The validator rejects missing, non-HTTPS, loopback, `.local`, and private-network origins.

Before creating a build, verify:

```sh
curl --fail https://navoss-api.yassin.app/health
curl --fail https://navoss-api.yassin.app/ready
curl --fail https://navoss-api.yassin.app/v1/config
```

Run a release export to prove the JavaScript bundle embeds the backend origin:

```sh
EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app \
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

Native Release compilation has already been exercised with signing disabled. The resulting arm64 archive used bundle ID `org.navoss.mobile`, version `0.1.0 (1)`, and a 3.0 MB embedded JavaScript bundle. That structural test archive is intentionally not uploadable. EAS now holds a valid Apple Distribution certificate and App Store provisioning profile for the production build.

EAS project `@yassinsolim/navoss` is linked in app configuration. Its production environment contains the verified `EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app`, and `submit.production.ios.ascAppId` is `6792619727`. The mobile package runs the release validator in EAS's pre-install hook.

Production build `0.1.0 (6)` was created from commit `71f00030a2a3ee286231a594f60a4f75f3482dbd` as EAS build `1733df54-89d3-4111-b6a4-c9de25860c48`. EAS submission `b34836ba-a24e-4226-8567-1144b836d1e8` uploaded it successfully, and Apple accepted the binary for processing. The refreshed provisioning profile permits the Apple-approved `com.apple.developer.carplay-maps` capability, but the audited app signature does not assert CarPlay or the deprecated `com.apple.developer.maps` entitlement. CarPlay source and entitlement flags remained unset.

Production build `0.1.0 (7)` was created from routing commit `c7356b74cb542be876b95db51dabce84d51195b8` as EAS build `4d3812fc-49e8-4f1e-80e4-011e21513881`. Submission `5e03d7b0-aacf-4f57-8ba2-662fa9da54a1` uploaded the dropped-pin and fastest-first alternatives release successfully.

Production build `0.1.0 (8)` was created from map-preset commit `001de31a85eb1f957b85983691c7a0a96ef23e09` as EAS build `7fcf71c3-fcab-4ccd-86f9-b9c857617250`. Submission `95b75664-67ea-4718-92d9-383005246d4c` uploaded the distinct Night/Contrast palettes, restored Night/Minimal landmarks, and Night-aware overlays/status bar. Apple accepted the binary for processing. CarPlay source and entitlement flags remained unset.

Production build `0.1.0 (9)` was created from place-details commit `96ca37ae63bba2570b27f203ac77647e9bfa3297` as EAS build `2bd8ab5e-2076-4625-aa91-0b7d78783490`. It was deliberately not submitted after iPhone SE simulator review found the arrival-time metric truncating in the redesigned navigation tray.

Production build `0.1.0 (10)` was created from compact-screen fix commit `ee10974b3d0d030e5cec8c7fa4db42fc5ce36d96` as EAS build `f8de57d9-43d3-433b-897e-3caf7c56847a`. The signed IPA passed bundle/version, signature, production-origin, foreground-location, Contacts/background-mode, and entitlement audits. The app signature asserts neither CarPlay nor deprecated Maps; its provisioning profile permits only the approved CarPlay navigation capability. EAS submission `4a8d0ddd-5ad9-4741-ba50-5fcb332f2603` successfully uploaded the binary to App Store Connect. Apple processing and clean-device TestFlight validation remain pending.

The `preview` profile is an ad hoc production-like build, not TestFlight. Use `production` for a phone-only store build. Use the dedicated `production-carplay` profile for a CarPlay tester build so the approved scene and entitlement are present:

```sh
eas build --platform ios --profile production-carplay
eas submit --platform ios --profile production-carplay
```

Before submitting the CarPlay candidate, inspect the signed IPA and confirm the app asserts `com.apple.developer.carplay-maps`, declares the `CPTemplateApplicationSceneSessionRoleApplication` scene and `location` background mode, and embeds `https://navoss-api.yassin.app`.

## Internal TestFlight

1. Wait for Apple to process the uploaded build.
2. Complete encryption/export-compliance prompts and verify the processed build details.
3. Create an internal group with only App Store Connect users who are actively testing.
4. Add the latest audited `production-carplay` candidate, paste the beta description and What to Test text, and invite the smallest useful internal group first.
5. Install that exact candidate from TestFlight on a clean iPhone. Confirm the app starts without Metro, reaches the production API, requests When in Use rather than Always location, continues active guidance while locked, stops location on End and arrival, opens named-place details, shares a place and static ETA without a Contacts prompt, long-presses to a dropped pin, shows ordered alternatives, preserves landmarks in every map preset, routes, speaks maneuvers, reroutes, arrives, displays all current cameras, connects to CarPlay, searches and starts a CarPlay route, and submits TestFlight feedback.
6. Soak for 48 hours before adding more testers. Stop rollout on crashes, invalid routes, stale closures, backend saturation, or misleading camera alerts.

Apple permits up to 100 internal testers associated with App Store Connect. Builds expire after 90 days.

## External TestFlight

After the internal gate passes:

1. Create an external group.
2. Complete Test Information, including beta description, feedback email, privacy-policy URL, and What to Test.
3. Verify the documented manual-origin or route-preview path from a device physically outside Calgary.
4. Add the tested build and submit it for Beta App Review.
5. Start with a small named cohort; do not begin with a public link.
6. Expand only after service and route-quality thresholds remain stable.

Apple permits up to 10,000 external testers, subject to Beta App Review.

## Public App Store gate

Do not submit the current technical beta as a full navigation replacement. Before public release, NavOSS needs reliable background guidance, spoken turn instructions, production map/search/routing operations, explicit traffic limitations or a traffic feed, wider route and on-road coverage, support response targets, and completed privacy/legal review.

## Apple references

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds-overview/)
- [Manage App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Submit for App Review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)

See `docs/release/app-review.md` for the current guideline risk matrix, privacy decision record, and channel-specific submission gates.
