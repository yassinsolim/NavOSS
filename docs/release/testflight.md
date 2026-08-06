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

Google Places photos, ratings, and reviews are a separate opt-in build path. Before enabling them, create a
billing-enabled Google Cloud project, enable Places UI Kit, restrict the iOS key to
`org.navoss.mobile` and the required API, store it as the EAS secret
`GOOGLE_PLACES_IOS_API_KEY`, set `NAVOSS_GOOGLE_PLACES_ENABLED=1`, and reconcile App Privacy and
the hosted policy. GooglePlacesSwift 10.15.0's underlying SDK privacy manifest declares precise and
coarse location, linked Device ID, linked Other Data, unlinked performance data, unlinked product
interaction, and unlinked search history for analytics and/or app functionality, with no tracking.
An enabled artifact must use matching App Store Connect answers and review notes. The release
validator and config plugin fail closed when the flag has no key. Checked-in production profiles
explicitly set `NAVOSS_GOOGLE_PLACES_ENABLED=0`; disabled builds do not link GooglePlacesSwift or
make place-details requests. Enabled builds use the standard Places UI Kit query rather than its
higher-priced advanced component. Every enabled query must first receive an anonymous grant from
the durable NavOSS counter, which hard-stops at 8,000 grants per UTC month and fails closed. Keep
Google-side quota limits and billing alerts as an independent second layer before release.

The anonymous grant counter is deployed at `a743cfb512b69b15da54a60aeeab93190187de4a` with
rollback `/home/navoss/NavOSS.pre-a743cfb-20260731T041459Z`. Two production probes returned 7,999
then 7,998 remaining grants for July 2026. The durable row contained only period `2026-07` and used
count `2`; its table has only `period`, `used`, and `updated_at` columns. The post-deploy live
certificate passed all 35 categories at 12 Calgary points, 601 current Ontario events near ten
cities, 301 Toronto cameras, and out-of-coverage rejection with zero failures.

The dedicated `navoss-mobile-6792619727` project is linked to billing and has only Places UI Kit
enabled for this feature. Exactly one active API key remains: `NavOSS iOS Places UI Kit`, restricted
to iOS bundle `org.navoss.mobile` and one API. All onboarding-generated 35-API keys are deleted, and
the restricted value is stored only as the secret EAS production variable
`GOOGLE_PLACES_IOS_API_KEY`. Google quotas are 250 standard queries/day, 30/minute, and
10/minute/user; unused Advanced and Session paths are limited to 1/day and 1/minute. This bounds a
31-day month to 7,750 standard queries before the independent NavOSS 8,000/month counter.

An 80% standard daily-quota alert sends to the `NavOSS Google Cloud alerts` email channel. A CAD $1
monthly budget scoped only to the NavOSS project and Places UI Kit alerts billing admins, project
owners, and that channel at 50%, 75%, 90%, and 100%. Budgets are delayed alerts, not hard caps. As
of July 30, 2026, Google lists the first 10,000 monthly UI Kit queries at no charge and the next
Canadian tier at about CAD $14.18 per 1,000; exchange-rate pricing can change. Google documents App
Check as unnecessary for private or experimental apps, so enforcement remains deferred during the
private TestFlight beta; add it and monitor valid-token adoption before public distribution.

Google place-details candidate `0.1.0 (35)` was built locally from release-record commit `efabe16`
with the `production-carplay-google` profile. Build 33 was consumed by a local pre-install failure
after a development HTTP origin overrode the production environment, and build 34 was consumed by
an interrupted archive; neither produced an IPA. The signed build 35 IPA has SHA-256
`e2944541dbc80d8540b154c6b76f2c1f954d7e979b2a1edbb652fc3c23afe70a`. Strict
signature, arm64 Store profile, production API, location-only background mode, CarPlay app/profile
entitlement and scene, Google-enabled flag and resources, 14 privacy manifests, and simulator-hook
absence passed audit. EAS submission `0994d6b7-9fd6-4f47-bdd5-88d1306e5d36` uploaded it
successfully to App Store Connect on July 30, 2026. Apple processing, enabled-build App Privacy
answers, internal `testers` attachment, live Google-content validation, and physical validation
remain pending.

CarPlay/search regression candidate `0.1.0 (39)` was built locally from commit `c62e4a8` with the
Google-disabled `production-carplay` profile. It expands route-preview context while preserving
route visibility, keeps the interpolated arrow/car and green route start synchronized, retains the
bounded cold-start GPS wait, and expands cinema queries so `chinook theater` and `cineplex chinook`
rank Scotiabank Theatre Chinook first. The signed IPA has SHA-256
`ac94e6672ed57c49b38c26689d966aae1481d9e93ee592dc453eef107c330291`. Build 39 passed
strict signature, arm64 App Store profile, CarPlay entitlement, production origin, privacy
manifest, Google-disabled packaging, 122 API tests, 50 native tests, and the seven-state CarPlay
visual/pixel suite. Apple processed build 39 successfully. EAS submission
`ccc484a5-729d-492b-92f6-df1c3b457617` requested internal group `testers`; Fastlane then returned
its known `Cannot add internal group to a build` false failure after processing and distribution.
The matching upstream issue reports that affected builds are nevertheless assigned correctly.
Independent portal confirmation remains pending because the App Store Connect web session expired.
Build 38, SHA-256 `8a2515b73f47a538984c2578bf38a58450cfecb75c86da5c31fd3dcd2386a871`,
was also uploaded successfully but is superseded by build 39.

The paired production search rollout is active at `c62e4a8`, with rollback snapshot
`/home/navoss/NavOSS.pre-c62e4a8-20260804T085214Z`. Public probes confirm `chinook theatre`,
`chinook theater`, `cineplex chinook`, and the full venue name all return Scotiabank Theatre
Chinook; the Cineplex alias ranks the venue ahead of mall escalator objects.

CarPlay Dashboard and idle-location candidate `0.1.0 (42)` was built locally from milestone
commits `813b312` and `fae9401` with the Google-disabled `production-carplay` profile. It stops
native Core Location when CarPlay is idle, scopes route-origin acquisition with independent
leases, preserves active-route recovery, registers the CarPlay Dashboard scene, renders shared
guidance there without a second navigation session, adds Go and Voice shortcuts, and refits route
previews after viewport changes. Apple controls which navigation app occupies the Dashboard tile;
Voice opens NavOSS search and is not a custom Siri recognizer. The signed IPA has SHA-256
`30a4f8477b4b9181d8317d11a758e9d7e039dc6d2cbd114c71c0e71e64367e4f`. Its strict Store audit
passed arm64, App Store profile, CarPlay entitlement, production origin, privacy manifest,
Google-disabled packaging, and phone/main CarPlay/Dashboard scene registration. Validation passed
52 native tests, 6 source-contract tests, all root gates (34 contracts, 122 API, 135 mobile, and 3
site tests), and the clean eight-state CarPlay OCR/pixel suite including viewport resize. Simulator
launch/terminate removed the process and left no blue location indicator. EAS submission
`b39219c2-cb3d-410b-9033-0ad88a339c50` uploaded the binary before Fastlane returned its known
post-upload unknown error. App Store Connect independently reports build 42 `VALID`,
`IN_BETA_TESTING`, and ready for external beta submission. TestFlight build 42 was installed on
the paired iPhone 15 Pro Max and CoreDevice confirmed bundle version 42. Physical CarPlay Dashboard
tile selection and shortcut behavior remain pending. Local build 40 was superseded before upload
after independent review found lifecycle races, and local build 41 was interrupted before producing
an IPA; neither was submitted.

Wider CarPlay preview candidate `0.1.0 (43)` was built locally from commit `310d6e7` with the
Google-disabled `production-carplay` profile. It lowers the route-choice preview zoom ceiling from
11.5 to 10.5, doubling the visible geographic span on the physical 800×480 layout while retaining
the left-side route-choice-sheet reservation. Clean native validation passed nine CarPlay states,
including a short-route regression with route-green ratio `0.000284` and a resized wide route with
regional context. The signed IPA has SHA-256
`49f9edc34897ec36f3730604483047c40e4e9fa6a4b4d76ef8dca47cdd81756b` and passed strict signature,
arm64, App Store profile, CarPlay entitlement, Dashboard scene, production origin, privacy
manifest, and Google-disabled packaging audits. EAS submission
`13b91d30-8a30-425f-80b2-697499fd15f6` completed successfully, and App Store Connect reports build
43 `VALID` and `IN_BETA_TESTING`. Physical installation and route-preview confirmation remain
pending.

CarPlay does not expose an API that lets NavOSS force itself into the Dashboard navigation widget,
and Canada's iOS Default Apps settings do not offer the region-limited Navigation default. The
route-choice sheet is preview state: NavOSS starts `CPNavigationSession` only after the user taps
the green Go button and CarPlay calls `startedTrip`. Returning Home before Go can therefore leave
Google Maps in the navigation widget. The physical Dashboard check must start a NavOSS trip before
returning Home.

Before creating a build, verify:

```sh
curl --fail https://navoss-api.yassin.app/health
curl --fail https://navoss-api.yassin.app/ready
curl --fail https://navoss-api.yassin.app/v1/config
```

### App Privacy reconciliation for the regional contribution build

The app-level privacy manifest now declares **Other User Content**, linked to identity
conservatively because free-form text may identify a person, used for **App Functionality**, and not
used for tracking. Apply the same answer in App Store Connect before attaching a replacement build:

1. Open **App Privacy** under the app's Distribution page and edit data collection.
2. Add **User Content → Other User Content**.
3. Select **App Functionality** as the only NavOSS purpose.
4. Answer that the data is linked to the user's identity conservatively.
5. Answer that the data is not used for tracking.

For a Google-disabled replacement build, do not add Google SDK declarations. For a
`production-carplay-google` build, also add the exact embedded Google Places declarations already
recorded above: precise/coarse location for Analytics and App Functionality; linked Device ID for
Analytics and App Functionality; linked Other Data for Analytics; unlinked Performance Data,
Product Interaction, and Search History for Analytics; no tracking.

The July 31 App Store Connect browser session redirected to login when opening Distribution, so no
account answer was saved. Reauthenticate as the account holder and record the saved state before
building or attaching the regional client.

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

Private-report candidate `0.1.0 (21)` was built locally from commit `4ddb93b7e4b36309738bf518b3290046f940b05d` with the `production-carplay` profile after the monthly EAS cloud-build quota was exhausted. The signed IPA has SHA-256 `0a7cdeae47dc7055c25bb66e1074112c2d45fd881d4c769dfacec081fafb61af`. Its strict signature, arm64 architecture, production API origin, location-only background mode, privacy manifest, vehicle arrow, CarPlay scene, app/profile CarPlay entitlements, Google-disabled packaging, expanded report labels, and absence of Always/Contacts strings and deprecated Maps entitlement passed local audit. EAS submission `48d12186-9c62-4dfc-81d4-701616d43242` finished without error. Apple processed the build, marked it Ready to Submit, attached it only to internal `testers`, and saved focused What to Test notes. The TestFlight build was then installed on the physical iPhone; XCUITest verified all eight report choices and the private two-hour notice, canceled without saving, ended guidance, and returned to route preview. Build 16 remains in external Beta App Review and was not replaced.

Navigation-fix candidate `0.1.0 (23)` was built locally from commit `b638812c77229b5bd1ef654441d1a7bbc8b739cb` with the `production-carplay` profile. Build number 22 was consumed by an unsuccessful local archive whose ExpoModulesJSI script inherited Homebrew LLVM; retrying with `CC` and `CXX` unset restored Apple's compiler and produced build 23. The signed IPA has SHA-256 `ba7fcd1f260d95d532e8467d07b4108ff0bbb50f974014594cfd3cb6d5297e68`. Strict signature, arm64 architecture, production API origin, location-only background mode, privacy manifests, 64-by-64 vehicle arrow, CarPlay scene, app/profile CarPlay entitlements, Google-disabled packaging, ordered-waypoint bridge, and absence of simulator visual hooks passed audit. EAS submission `9c99fb40-a595-45ec-9f4b-630e21d89ae0` uploaded it successfully to App Store Connect on July 28, 2026. Apple processed it, marked it Ready to Submit, attached it to internal `testers`, and saved focused arrow, route-stop, Parks, and Groceries test notes.

The same milestone adds a phone route-stop editor with search, add, remove, and ordered move controls; Valhalla and the optional licensed Mapbox provider preserve intermediate waypoint order, and native rerouting retains only unvisited stops. The deterministic phone suite passed stop editing, guidance, reporting, rerouting, arrival, screenshots, and cleanup. Production API revision `b638812` is deployed with rollback `/home/navoss/NavOSS.pre-b1c172e-20260728T210214Z`: typed Parks excludes restaurants and other businesses, while proximity-ranked Groceries includes Calgary Co-op, Safeway, and Sobeys and filters out liquor stores.

During a live wireless CarPlay session, CoreDevice confirmed NavOSS and `CarPlayTemplateUIHost` running with external display 3 active at 800 by 480. Apple's DVT screenshot API returned only the phone LCD, so it could not capture the external framebuffer. Source inspection identified the visible wrong-way arrow: a map-aligned symbol was also given `course - map bearing`, subtracting camera rotation twice. Build 23 supplies absolute matched course to the map-aligned symbol on both phone and CarPlay. A clean CarPlay visual run passed native tests, fresh device-source compilation, light/dark preview, 5% and 60% heading-up guidance, route cleanup, and screenshot analysis; final confirmation still requires installing build 23 and observing the real head unit.

CarPlay parity candidate `0.1.0 (24)` was built locally from commit `eb4ae63241fe5507eb81bed98fc019b23db2186c` after comparing the physical Google Maps/Waze evidence with NavOSS's Apple-template implementation. Active guidance replaces permanent zoom buttons with End, route overview/follow, and persistent sound controls; camera distance adapts to upcoming maneuver distance; and 3D building extrusions are hidden while driving so the route and arrow dominate. Idle and preview maps retain recenter and zoom. The visual harness now covers preview light/dark, adaptive 5% and 60% follow states, 40% route overview, and route cleanup with direct route-green pixel validation. All 35 native tests, full repository gates, regenerated source parity, full iOS compilation, and the six-scenario CarPlay suite passed.

The signed build 24 IPA has SHA-256 `a954fa6bcda5a3d97b6b0a35940fbfb79006368cc3fcd6879774b4f6df2bd7d5`. Strict signature, arm64 architecture, production API configuration, location-only background mode, CarPlay app/profile entitlement and scene, Google-disabled packaging, sound controls, and simulator-hook absence passed audit. EAS submission `77995dc5-8fe4-4cb8-8759-b807aff504f4` uploaded it successfully to App Store Connect on July 28, 2026; Apple processing, internal-group attachment, and physical CarPlay validation remain pending.

Complete CarPlay-controls candidate `0.1.0 (26)` was built locally from commit `a5e1f5d04fddb23312c78feff13f26a7353eeda9`. Build number 25 was consumed by a local EAS temporary-workspace deletion while Fastlane was still compiling; the isolated retry produced build 26. Idle/parked CarPlay now exposes direct Search, recenter, and Settings map controls. Settings persists Automatic/Light/Dark appearance and All guidance/Alerts only/Muted audio modes; Alerts only preserves camera notifications while suppressing maneuver speech. Active guidance exposes End, overview/follow, sound settings, and a private Report list with the phone's eight labels, precise local coordinate, 25-draft bound, and two-hour expiry. Reports are not public and include no checkpoint/police or free-text option.

Build 26's explicit Dark style uses a bright route with dark casing instead of a washed-out white halo. All 37 native tests, full repository gates, clean generated-source parity, full iOS compilation, and six-scenario CarPlay visual validation passed. The signed IPA has SHA-256 `c59f1e40669c9f93ec17a1e7debdcaceca47fa6fd3153afe7be6d26574074950`; strict signature, arm64, production configuration, CarPlay app/profile entitlement and scene, location-only background mode, Google-disabled packaging, and simulator-hook absence passed audit. EAS submission `a8d7e2de-a355-46d9-acc5-889cff6517f9` uploaded it successfully to App Store Connect on July 28, 2026; Apple processing, internal-group attachment, and physical CarPlay validation remain pending.

CarPlay guidance/search candidate `0.1.0 (28)` was built locally from commit `cf4d9e05a7b2c74bfbdcd78d009227f8c937e16f`. Build number 27 was consumed when the first local EAS attempt inherited Command Line Tools as the active developer directory; Fastlane could not locate full Xcode. The isolated retry explicitly set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` and produced build 28.

Build 28 renames the root Places action to Search, adds nearby phone-aligned categories, preserves strict restaurant/grocery/park category intent, and requests distance ordering. Active guidance displays GPS-derived current speed and known geometry-aligned OpenStreetMap/Valhalla posted speed limits; unknown limits remain hidden. It removes the awkward compass ornament, interpolates marker/course only between real matched updates, and adds persistent POI visibility plus Arrow/Car choices to the existing appearance and audio settings. Production API commit `cf4d9e0` is deployed with rollback `/home/navoss/NavOSS.pre-cf4d9e0-20260730T194739Z`; public validation returned 72 route points, 71 aligned speed-limit segments, known 40/50 km/h values, nearest-first category results, and healthy self-hosted routing.

All 39 native tests, 18 contract tests, 69 API tests, 98 mobile tests, full repository check/lint/test/build/format gates, generated-source/resource parity, full iOS compilation, and the clean six-scenario CarPlay visual suite passed. The signed IPA has SHA-256 `6050eae1b632f71fa2519266356d300156a4c18776d352e6f0f222112d71742a`; strict signature, arm64, production API, location-only background mode, CarPlay app/profile entitlement and scene, arrow/car assets, Google-disabled packaging, and simulator-hook absence passed audit. EAS submission `1342c249-fc5c-4b63-aa4f-31aad64fa5a3` uploaded it successfully to App Store Connect on July 30, 2026. Apple processing, internal `testers` attachment, and physical validation of speed, marker smoothness, Search categories, settings, and head-unit layout remain pending.

Continuous road-context candidate `0.1.0 (29)` was built locally from commit
`d203112b60676f69add7f7eb313965b62bb460c2` with the Google-disabled
`production-carplay` profile. The backend now polls validated City of Calgary construction and
incident feeds every five minutes even without client requests. It also exposes official Ontario
511 construction, closure, and incident points through `GET /v2/events?region=ontario`; the phone
switches event sources by region, keeps source-specific confidence language visible, and does not
use these overlays for routing, ETA, rerouting, or speech. Police patrol, checkpoint, and speed-trap
tracking remain excluded.

The first production activation of feature commit `c64d1a0` failed because a Fastify `onClose` hook
was registered after the thenable app had finalized startup. The preserved release was immediately
restored and rebuilt at `7efac72`; production returned healthy with zero restarts. Corrective commit
`d203112` moves lifecycle registration inside app construction and adds a listen-and-close regression
test. A compiled-server smoke test then returned health 200 and a contract-valid Ontario response
before redeployment. Disposable BuildKit cache had also filled the 37 GiB root filesystem; the failed
release tree was preserved under `/srv/navoss/artifacts/deploy-failures`, and pruning only BuildKit
cache recovered 24 GiB. No database, routing graph, search index, image, or validated rollback tree
was removed.

Production is deployed at `d203112b60676f69add7f7eb313965b62bb460c2` with rollback
`/home/navoss/NavOSS.pre-d203112-20260730T2128Z`. The full stack smoke passed. Public contract probes
returned 303 Calgary events and 613 official Ontario points, including 602 construction events, 10
incidents, and one closure, with valid bounds and fresh source metadata. Both Calgary and Ontario
`generatedAt` values advanced independently across the next five-minute boundary, proving the
server-owned pollers were active. The API container remained healthy with zero restarts and no recent
error log entries.

All 23 contract tests, 83 API tests, 100 mobile tests, repository check/lint/test/build/format gates,
compiled-server startup, and iOS export passed. The signed build 29 IPA has SHA-256
`1bbcc2c8ad72d4462effed9e027a401aa818163510114e1e0a31ffcf7987b28a`; strict signature,
arm64 Store profile, production API, location-only background mode, CarPlay app/profile entitlement
and scene, Google-disabled packaging, and simulator-hook absence passed audit. EAS submission
`a458bce8-cd70-4b1b-80ce-ee54edc05ee6` uploaded it successfully to App Store Connect on July 30, 2026. Apple processed build UUID `8679668f-247d-4a59-919a-b4dbdfc47a46` to **Ready to Submit** and
attached it to the internal `testers` group (`19f370cc-daee-4d76-b52e-acc4f0da2a84`, one tester).
Focused What to Test notes are saved for Calgary and Ontario marker confidence, event details,
Road events visibility, delayed refresh retention, non-interference with route/ETA/speech, and
Search/navigation/CarPlay regressions. App Store Connect reports binary state **Validated**,
non-exempt encryption **No**, arm64, `get-task-allow: false`, beta reports active, and the approved
CarPlay maps entitlement. Physical phone/CarPlay validation of the new road-event overlays remains
pending.

Restaurant proximity was repaired server-side after build 29 processing; no replacement binary is
required. The self-hosted Nominatim database had no category special phrases, so `[restaurant]` was
treated as literal name text and omitted nearby places whose names did not contain “Restaurant.”
Commit `e82addd9213473fc2232b9623d39e90046c3c6ea` adds deterministic phrases for restaurant,
fast-food, food-court, supermarket, and park tags, plus a repeatable service-account import. The API
now merges three concentric category searches, deduplicates identical OSM IDs, and ranks the complete
candidate pool by exact distance. Production is deployed at that commit with rollback
`/home/navoss/NavOSS.pre-e82addd-20260730T2153Z`.

Public Aspen validation improved the first result from 2.2 km away to 560 m and returned nearby
Freshii, Kabuku, Original Joe's, Redwater Grill, and Mucho Burrito within 681 m. Downtown results
started at 358 m. Both probes returned 20 strictly distance-sorted records with only validated
restaurant, fast-food, and food-court types. The full stack smoke passed; the API was healthy with
zero restarts and no recent errors. Full repository gates passed with 23 contract, 84 API, 100 mobile,
and three site tests.

Automatic-location and road-symbol candidate `0.1.0 (30)` was built locally from commit
`3d65ea8`. Fresh installs now request foreground location on startup, automatically centre after a
grant, reuse existing permission without prompting, and avoid repeatedly prompting after iOS blocks
another request. The recenter button remains available for an explicit high-accuracy refresh. A
dedicated simulator flow reset location privacy, launched without tapping recenter, and verified a
distance-labelled Calgary International Airport result plus no location-unavailable warning.

Construction now uses an amber work-zone sign, closures a red no-entry sign, and incidents a coral
warning sign. MapLibre collision placement prevents the roughly 300 Calgary construction symbols
from overlapping into an unreadable field. Live simulator evidence showed the new construction
symbols rendered separately from the existing safety-camera icon. NavOSS still has no police
patrol, checkpoint, or speed-trap feed and therefore does not show a police-location symbol.

Full repository check/lint/test/build/format gates passed with 23 contract, 84 API, 103 mobile, and
three site tests. A clean native simulator build passed and Metro exported all 47 assets. The
integrated reuse-build phone run passed the new automatic-location checkpoint, phone
preview/guidance/report checkpoints, automatic rerouting, and pixel validation. Its unchanged final
arrival launch timed out because Expo's development menu covered the app; the arrival implementation
was not changed, and its previous deterministic validation remains the release evidence for that
slice.

The signed build 30 IPA has SHA-256
`af8ebee668107b6b934f3c478f768ecfc2ec88be9831ed87408bd1206321444b`. Strict
signature, arm64 Store profile, production API, location-only background mode, CarPlay app/profile
entitlement and scene, all three road-event marker assets, Google-disabled packaging, and
simulator-hook absence passed audit. EAS submission
`f2b7c935-9a83-421b-b2ce-c07ced46cffc` uploaded it successfully to App Store Connect on July 30, 2026. Apple processing, internal `testers` attachment, focused What to Test notes, and physical
phone/CarPlay validation remain pending.

Exhaustive Explore-filter candidate `0.1.0 (31)` was built locally from commits `9f237fd`,
`c3c7836`, and `5b58eba`. The previous app sent typed intent only for Restaurants, Parks, and
Groceries; every other filter was plain text, causing Bars to return barbershops, Car repair to
return car washes, ATMs to match “Atmosphere,” and many filters to return nothing. All 35 supported
filters now use shared typed intent, checked-in Nominatim phrase mappings, strict OSM-type
allowlists, concentric proximity pools, identical-ID deduplication, and exact-distance ranking.
Brunch and Delivery were removed because OSM does not identify those attributes consistently enough
for a trustworthy filter.

The first exhaustive API deployment exposed a second production issue during the two-location
acceptance matrix: dense categories containing unnamed OSM features, including Parks and Parking,
failed response serialization because an empty source name was preserved. The API now falls back to
the display label and drops empty optional detail strings. Production is deployed at
`5b58eba83c9dd7820d4d207c83ea0724c2a857fd` with rollback
`/home/navoss/NavOSS.pre-5b58eba-20260730T2307Z`. The complete 35-filter matrix passed at Aspen and
downtown with zero non-200 responses, type leaks, barber matches, ordering errors, or contract
failures. Aspen Parks began at 502 m and Bars returned only `bar`/`pub`; downtown Parks began at
288 m and all 35 filters were nonempty. The full stack smoke passed, the API remained healthy with
zero restarts, and no recent errors were logged.

All repository check/lint/test/build/format gates passed with 23 contract, 87 API, 103 mobile, and
three site tests. Exhaustive tests prove phone/contract category equality, phrase/allowlist equality,
and cross-category leak rejection for every filter. The signed build 31 IPA has SHA-256
`85cb7209dfa42558e03e10a606400250330b8099a8617662996ee35b1092c437`; Store signature,
arm64, production API, location-only background mode, CarPlay app/profile entitlement and scene,
Google-disabled packaging, and simulator-hook absence passed audit. EAS submission
`9d3646df-f486-46d0-9aa3-e26634158d99` uploaded it successfully to App Store Connect on July 30, 2026. Apple processing, internal `testers` attachment, focused test notes, and physical validation
remain pending.

Regional-coverage guard `de99092b8a276a3a40351339b95a0c4ec7b24980` prevents typed nearby
category searches outside Calgary from returning distant Alberta places. The API returns a stable
coverage error, and the phone blocks Explore outside the covered bounds while retaining honest
Ontario road events and Toronto camera display. Production is deployed at that exact commit with
rollback `/home/navoss/NavOSS.pre-de99092-20260730T2330Z`.

The checked-in live certification passed with zero failures across all 35 categories at 12 Calgary
locations, including downtown, all four quadrants, suburban edges, and the airport industrial area.
Sparse categories returned empty honestly; all returned results passed status, OSM-type, exact
distance-order, contract, and barber-leak checks. The same run found 603 fresh official Ontario road
events near ten cities from Windsor to Thunder Bay, 301 in-bounds Toronto cameras, and confirmed
that a Toronto category request is rejected rather than returning Calgary results. Repository gates
passed with 23 contract, 88 API, 104 mobile, and three site tests.

Regional-coverage candidate `0.1.0 (32)` was built locally from release-record commit `2e0bdd5`
with the `production-carplay` profile. The signed IPA has SHA-256
`fc6ce1a236ce3c19d2bc622ff34eb6fd8fb73fb66fc2998e95a41791ca23658a`; its Store
signature, arm64 binary, production API, location-only background mode, CarPlay app/profile
entitlement and scene, Google-disabled packaging, and simulator-hook absence passed audit. EAS
submission `8d00249f-c7da-478e-b74b-1e3b5b2c93a0` uploaded it successfully to App Store Connect on
July 30, 2026. Apple processing, internal `testers` attachment, focused test notes, and physical
validation remain pending.

## Kelowna backend deployment certificate

Production deployed commit `d3dd12d88f7fbd2e353a29b773e478aa37522ab0` on July 31, 2026,
with rollback tree `/home/navoss/NavOSS.pre-a743cfb-20260731T161935Z`. Nominatim and Valhalla use
the same checksum-verified Geofabrik `260730` Alberta and British Columbia release through versioned
artifact directories. The final Nominatim database is 6.0 GiB; the Valhalla graph is 2.8 GiB with
3,344 tiles. Production retained 13 GiB available RAM and zero meaningful swap use after cutover.

The live search gate passed with zero failures across all 35 categories at 12 Calgary and five
Kelowna locations. Kelowna locations returned 28–34 nonempty categories each; every essential
category was present somewhere in the service area, responses used the self-hosted regional source,
and no Calgary fixture or civic-index result leaked into Kelowna searches. Ontario 511 and Toronto
camera checks remained healthy.

The live route gate passed 25 variants at 243 ms p95: all existing Calgary routes, six Kelowna local
routes, and both Calgary–Kelowna intercity directions. Calgary to Kelowna was 608.9 km and Kelowna
to Calgary was 617.9 km. Every response remained nondegraded self-hosted Valhalla with no live
traffic claim.

Live Kelowna context returned one current DriveBC event, four ordinary traffic webcams with
`enforcement: false`, and exactly two fixed RCMP public facilities. Anonymous contribution
submission was accepted through public ingress, verified in PostgreSQL, and the certification row
was deleted. Existing signed builds remain compatible through the unchanged strict Calgary
`/v1/config`; the new regional client uses `/v2/config`. A replacement signed build is required
before TestFlight users can access the Kelowna UI and unrestricted map changes.

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
