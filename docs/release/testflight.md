# TestFlight beta runbook

Date: 2026-07-28

## Current verdict

| Stage                                      | Verdict | Reason                                                                                                                                                                                                    |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local simulator and build-12 physical beta | GO      | Core, API, mobile, native, route-matrix, places, ETA sharing, reroute, arrival, camera, privacy-sheet, compact-screen, and outside-Calgary reviewer-preview checks pass.                                  |
| Metro-independent iOS Release export       | GO      | Signed discovery and CarPlay build `0.1.0 (15)` passed identity, signature, entitlement, production-origin, privacy, CarPlay-scene, architecture, asset, and shipped-feature audits.                      |
| Internal TestFlight                        | GO      | Build 17 is installed on the physical iPhone and passed stationary discovery, place, route, guidance, lock recovery, report-sheet, and End checks. Real on-road and CarPlay testing remain release gates. |
| External TestFlight                        | WAITING | Build 16 is attached to `NavOSS Friends` and Beta App Review is `WAITING_FOR_REVIEW`. Its capped public link is enabled but cannot accept testers until Apple approves the build.                         |
| Public App Store                           | NO-GO   | Physical-device background/CarPlay evidence, traffic-aware ETA, production service operations, and broader safety/quality evidence remain incomplete.                                                     |

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
- [x] Build, audit, and upload voice-tuned candidate `0.1.0 (14)` from commit `35afb26`.
- [x] Build and audit discovery and CarPlay candidate `0.1.0 (15)` from commit `fa10bfe`; EAS reports its submission completed.
- [x] Confirm build 15 reaches App Store Connect and is attached to `testers`.
- [x] Confirm build 16 is processed, Ready to Submit, and attached to `testers` in App Store Connect.
- [x] Install build 17 through TestFlight and physically validate the discovery shell, nearest-first Gas results, place details, route alternatives, stationary guidance, locked-phone recovery, report-sheet safety copy, and End cleanup.
- [ ] Physically validate Toronto camera rendering, a lawful local report draft, moving guidance, arrival/rerouting, and real wired/wireless CarPlay.

### P1: required before external testers

- Run at least a 24-hour backend soak with readiness monitoring, TLS renewal monitoring, latency/error alerts, and a rollback procedure.
- Complete the manual Apple/Google worksheet in `docs/testing/route-quality.md`; investigate every safety, legality, endpoint, or major road-choice discrepancy.
- Run passenger-operated on-road tests across downtown, Deerfoot Trail, Stoney Trail, complex interchanges, weak-GPS areas, destination arrival, rerouting, and camera approaches.
- Add crash diagnostics or document the privacy-preserving alternative and support triage process.
- Confirm map/search/routing data attribution and production usage rights in the shipped UI and hosted legal pages.
- [x] Add and validate the visible, preview-only Calgary Tower origin path so Beta App Review can exercise routing from outside Calgary.
- [x] Create the external TestFlight group `NavOSS Friends`.
- Activate and externally test `navoss@yassin.app` delivery and reply handling.
- [x] Save reachable private review contact details and attach build 16 to `NavOSS Friends`.
- [x] Save the beta description, live URLs, build 16 What to Test, no-sign-in posture, and reviewer notes.
- [x] Submit build 16 for Beta App Review; Apple returned `WAITING_FOR_REVIEW` on July 28, 2026.
- [x] Create the public link with a hard limit of 10 testers. Do not share it until Apple approves build 16.
- [x] Build, audit, upload, and internally distribute nearest-search fix `0.1.0 (17)` from commit `323cd94`.
- Verify active guidance, speech, rerouting, arrival, and End cleanup while the screen is locked. For the CarPlay profile, repeat the flow on wired and wireless systems and confirm the minimal phone companion remains non-distracting.

## Backend release gate

Set the final origin and run:

```sh
EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app \
  corepack pnpm --filter @navoss/mobile validate:release
```

The validator rejects missing, non-HTTPS, loopback, `.local`, and private-network origins.

Google Places ratings are a separate opt-in build path. Before enabling them, create a
billing-enabled Google Cloud project, enable Places UI Kit, restrict the iOS key to
`org.navoss.mobile` and the required API, store it as the EAS secret
`GOOGLE_PLACES_IOS_API_KEY`, set `NAVOSS_GOOGLE_PLACES_ENABLED=1`, and reconcile App Privacy and
the hosted policy. GooglePlacesSwift 10.15.0's underlying SDK privacy manifest declares precise and
coarse location, linked Device ID, linked Other Data, unlinked performance data, unlinked product
interaction, and unlinked search history for analytics and/or app functionality, with no tracking.
An enabled artifact must use matching App Store Connect answers and review notes. The release
validator and config plugin fail closed when the flag has no key. Checked-in production profiles
explicitly set `NAVOSS_GOOGLE_PLACES_ENABLED=0`; disabled builds do not link GooglePlacesSwift or
make rating requests.

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

Voice-tuned candidate `0.1.0 (14)` was created from commit `35afb269a655b364b9e524e4d4404f19b63f2eb8` as EAS build `c3517f62-7566-43b6-8ab6-a4f2e71a3f25`. The signed IPA has SHA-256 `ba48954ea6fd81f2fbd9ea33c2beff2762e318fd4a3f0acd51fcf1c35f73b9e6` and passed bundle/version, strict code-signature, designated-requirement, production-origin, When in Use purpose-string, background-mode, CarPlay scene, app-entitlement, provisioning-profile, privacy-manifest, and arm64 audits. Its native executable differs from build 13 and EAS ties it to the exact voice-tuned source commit. EAS submission `a13489b8-8a45-4f9f-a537-9e5cf98fd002` uploaded it successfully to App Store Connect at 2026-07-24 10:25 UTC. Apple processing and physical TestFlight validation remain pending.

Discovery and CarPlay candidate `0.1.0 (15)` was created from commit `fa10bfeec7fe3bc3bf256217947b3e7f3f710cf4` as EAS build `630e78d6-6beb-4738-92f1-2834ee1733fa`. The signed IPA has SHA-256 `827d5017f36690a36bcc4e4f1dc1edb0986eac244256aaaf2ccd90c4ac494a97` and passed bundle/version, strict code-signature, production-origin, When in Use purpose-string, location-only background-mode, CarPlay scene, app-entitlement, provisioning-profile, privacy-manifest, arm64, packaged 64-by-64 vehicle-arrow, Google-disabled packaging, discovery-label, rating-fallback, and native CarPlay End-control audits. EAS submission `8365a1f6-568d-44d8-bac1-578f83fb95d8` uploaded it successfully to App Store Connect at 2026-07-25 05:24 UTC and targeted the internal `testers` group. Apple processing, TestFlight installation, and physical validation remain pending.

Toronto/reporting candidate `0.1.0 (16)` was uploaded on July 27, 2026 after commit `112cae172fd90f6ed84e5524e32692c9f71e4a51` as EAS build `cbcf7876-5bc9-4fa4-bffc-122df48253d6`; EAS submission `d7e313c6-3856-46f7-9de2-efbd081f8562` completed successfully. App Store Connect processed it and attached it to the internal `testers` group. On July 28, its beta description, build notes, private reviewer contact, no-sign-in posture, reviewer notes, and external `NavOSS Friends` group were verified. Build 16 was submitted for Beta App Review and Apple returned `WAITING_FOR_REVIEW`. Its clean TestFlight installation and physical navigation/CarPlay checks remain pending.

Nearest-search candidate `0.1.0 (17)` was created from commit `323cd943e5fa8b850368a7511269d1b7587ca617` as EAS build `78d3f5de-2c5b-406b-8884-400b2b8f2a93`; EAS submission `9fd3437c-1eeb-4cb1-a586-cad1ad446b04` completed successfully. Its signed IPA has SHA-256 `27a5503aee894c3d9b85393f2a5d8c9c11c5e14630cff8761a1a38d71a08d612` and passed bundle/version, strict signature, CarPlay app/profile entitlement, scene, permission, production-origin, privacy-manifest, arm64, vehicle-arrow, and Google-disabled audits. App Store Connect processed it and attached it to the internal `testers` group. Build 17 remains internal-only while build 16 is in external Beta App Review. Production API commit `b149058` restores non-degraded Calgary/OpenStreetMap hybrid results by accepting valid nullable Nominatim extra tags.

On July 28, build 17 was installed from TestFlight on an iPhone 15 Pro Max running iOS 26.5.2. XCUITest confirmed nearest-first Gas results, the attributed Shell place sheet and Google Maps review handoff, a selected 650 m route plus 890 m alternative, stationary active guidance, lock/background recovery, private report safety copy, End cleanup, and return to route preview. The same destination produced an approximately 644 m Waze route. This is strong phone evidence, but it is not a moving-road, arrival/reroute, Toronto, or real wired/wireless CarPlay pass.

Private-report candidate `0.1.0 (21)` was built locally from commit `4ddb93b7e4b36309738bf518b3290046f940b05d` with the `production-carplay` profile after the monthly EAS cloud-build quota was exhausted. The signed IPA has SHA-256 `0a7cdeae47dc7055c25bb66e1074112c2d45fd881d4c769dfacec081fafb61af`. Its strict signature, arm64 architecture, production API origin, location-only background mode, privacy manifest, vehicle arrow, CarPlay scene, app/profile CarPlay entitlements, Google-disabled packaging, expanded report labels, and absence of Always/Contacts strings and deprecated Maps entitlement passed local audit. EAS submission `48d12186-9c62-4dfc-81d4-701616d43242` finished without error. Apple processing and internal-group attachment remain pending; do not replace build 16 in external Beta App Review.

The `preview` profile is an ad hoc production-like build, not TestFlight. Use `production` for a phone-only store build. Use the dedicated `production-carplay` profile for a keyless CarPlay tester build so the approved scene and entitlement are present. After the restricted EAS Google key and matching App Privacy answers are ready, use `production-carplay-google` for the rating-enabled candidate:

```sh
eas build --platform ios --profile production-carplay
eas submit --platform ios --profile production-carplay
eas build --platform ios --profile production-carplay-google
eas submit --platform ios --profile production-carplay-google
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
5. After Beta App Review approval, share the already-enabled public link with the intended friend
   cohort. Its hard limit is 10 testers; disable the link if it spreads beyond that group.
6. Expand only after service and route-quality thresholds remain stable.

Apple permits up to 10,000 external testers, subject to Beta App Review.

As of July 28, 2026, build 16 is attached to both the internal `testers` group and external `NavOSS
Friends` group. Beta App Review is `WAITING_FOR_REVIEW`. The external group has zero testers and a
hard public-link limit of 10. Its link is `https://testflight.apple.com/join/KyZPPD4m`; Apple shows
that it is not accepting new testers until review approval. Do not publish the direct EAS IPA
artifact URL as a TestFlight link; it is not a friend-install invitation.

## Public App Store gate

Do not submit the current technical beta as a full navigation replacement. Before public release, NavOSS needs physical on-road and real-CarPlay evidence, wider route and search coverage, explicit traffic limitations or a traffic feed, support response targets, and completed privacy/legal review. Background guidance, spoken turn instructions, and production map/search/routing operations are implemented but still require sustained field evidence.

## Apple references

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds-overview/)
- [Manage App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Submit for App Review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)

See `docs/release/app-review.md` for the current guideline risk matrix, privacy decision record, and channel-specific submission gates.
