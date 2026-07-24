# TestFlight beta runbook

Date: 2026-07-24

## Current verdict

| Stage                                      | Verdict | Reason                                                                                                                                                                               |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local simulator and build-12 physical beta | GO      | Core, API, mobile, native, route-matrix, places, ETA sharing, reroute, arrival, camera, privacy-sheet, compact-screen, and outside-Calgary reviewer-preview checks pass.             |
| Metro-independent iOS Release export       | GO      | Signed build `0.1.0 (13)` passed identity, signature, entitlement, production-origin, privacy, CarPlay-scene, and packaged-asset audits.                                             |
| Internal TestFlight                        | NO-GO   | Build 12 remains the installed diagnostic build. Build 13 is processed for the internal `testers` group and still needs installation and physical smoke testing.                     |
| External TestFlight                        | NO-GO   | Reviewer route preview is complete. Internal soak, App Privacy/account-holder fields, Beta App Review, on-road evidence, support operations, and real wired/wireless CarPlay remain. |
| Public App Store                           | NO-GO   | Physical-device background/CarPlay evidence, traffic-aware ETA, production service operations, and broader safety/quality evidence remain incomplete.                                |

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
- [x] Build, audit, and upload CarPlay/reviewer candidate `0.1.0 (12)` from commit `931fe5b`; both its app signature and provisioning profile assert `com.apple.developer.carplay-maps`.
- [ ] Classify Cloudflare/OpenFreeMap map and network metadata, then reconcile App Store Connect App Privacy, `PrivacyInfo.xcprivacy`, SDK manifests, and the hosted policy.
- [ ] Complete the account-holder age-rating, content-rights, and export-compliance decisions.
- [x] Install build 12 from TestFlight after processing and verify launch, production search, and route preview without Metro.
- [x] Build, audit, and upload feedback-fixed replacement `0.1.0 (13)` from commit `eb8d997`.
- [x] Confirm build 13 is processed, Ready to Submit, and attached to the internal `testers` group.
- [ ] Install the newest voice-tuned candidate through TestFlight and physically validate locked-phone guidance and real wired/wireless CarPlay.

### P1: required before external testers

- Run at least a 24-hour backend soak with readiness monitoring, TLS renewal monitoring, latency/error alerts, and a rollback procedure.
- Complete the manual Apple/Google worksheet in `docs/testing/route-quality.md`; investigate every safety, legality, endpoint, or major road-choice discrepancy.
- Run passenger-operated on-road tests across downtown, Deerfoot Trail, Stoney Trail, complex interchanges, weak-GPS areas, destination arrival, rerouting, and camera approaches.
- Add crash diagnostics or document the privacy-preserving alternative and support triage process.
- Confirm map/search/routing data attribution and production usage rights in the shipped UI and hosted legal pages.
- [x] Add and validate the visible, preview-only Calgary Tower origin path so Beta App Review can exercise routing from outside Calgary.
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

CarPlay build `0.1.0 (11)` was created from native-navigation commit `d3b891135adce524a211ca1c472eb54729692b20` as EAS build `fcc20e6f-69a1-453a-a620-9cb377ea7567`. It was the first signed CarPlay artifact and proved that the App Store profile and app signature both preserve `com.apple.developer.carplay-maps`.

External-review candidate `0.1.0 (12)` was created from commit `931fe5b969203329bd1b17d7a67a46a3e24176d0` as EAS build `4de49ea0-c9f1-4074-a819-290cc542da75`. Its signed IPA passed bundle/version, code-signature, designated-requirement, production-origin, When in Use purpose-string, background-mode, CarPlay scene, app-entitlement, and provisioning-profile audits. The visible Calgary Tower preview path passed from a San Francisco simulator location on the iPhone 15 Pro Max and iPhone SE; Start is absent until **Use my location** returns to real-location routing. EAS submission `40721a3c-b8a3-4a73-aebf-8c033c8f16d0` uploaded the binary successfully to App Store Connect at 2026-07-23 14:01 UTC. Apple processed it, and it was installed through TestFlight for the internal physical smoke and feedback session. It remains a diagnostic build; the current feedback fixes require a replacement candidate.

Feedback-fixed candidate `0.1.0 (13)` was created from navigation commit `eb8d997b11c547f2a53ee13f96c43ffbc9816c89` as EAS build `723d6f3e-7feb-41c9-bf3b-97f9f77af5d5`. The signed IPA has SHA-256 `0747ced3468a2ebcce52669a30348755977caf09aeba77cc6e8009fdb4523f10` and passed bundle/version, strict code-signature, designated-requirement, production-origin, When in Use purpose-string, background-mode, CarPlay scene, app-entitlement, provisioning-profile, privacy-manifest, arm64, and packaged-vehicle-asset audits. EAS submission `885f4b87-7a7a-4934-a703-df60556a732f` uploaded it successfully to App Store Connect at 2026-07-24 08:59 UTC. Apple processed it, marked it Ready to Submit, and attached it to the internal `testers` group. Physical TestFlight validation remains pending.

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
3. From outside Calgary, search for Airport, select Calgary International Airport, tap **Preview from Calgary Tower**, and verify the **Preview only from Calgary Tower** route has no Start action until **Use my location** is chosen.
4. Add the tested build and submit it for Beta App Review.
5. Start with a small named cohort; do not begin with a public link.
6. Expand only after service and route-quality thresholds remain stable.

Apple permits up to 10,000 external testers, subject to Beta App Review.

## Public App Store gate

Do not submit the current technical beta as a full navigation replacement. Before public release, NavOSS needs physical on-road and real-CarPlay evidence, wider route and search coverage, explicit traffic limitations or a traffic feed, support response targets, and completed privacy/legal review. Background guidance, spoken turn instructions, and production map/search/routing operations are implemented but still require sustained field evidence.

## Apple references

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds-overview/)
- [Manage App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Submit for App Review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)

See `docs/release/app-review.md` for the current guideline risk matrix, privacy decision record, and channel-specific submission gates.
