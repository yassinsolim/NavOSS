# TestFlight beta runbook

Date: 2026-07-20

## Current verdict

| Stage                                     | Verdict | Reason                                                                                                                                                                                                 |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local simulator and physical-device alpha | GO      | Core, API, mobile, native, route-matrix, reroute, arrival, camera, and privacy-sheet checks pass.                                                                                                      |
| Metro-independent iOS Release export      | GO      | A July 20 Hermes export embeds `https://navoss-api.yassin.app`, uses POST search, and contains no retired, localhost, or LAN endpoint. The earlier unsigned native archive also compiled successfully. |
| Internal TestFlight                       | NO-GO   | Build `0.1.0 (5)` is uploaded and processing at Apple. App Privacy/provider classification, owner questionnaires, and a clean-device build 5 smoke test remain.                                        |
| External TestFlight                       | NO-GO   | Internal soak, reviewer-accessible Calgary route planning, Beta App Review metadata, on-road evidence, support operations, and the internal blockers are incomplete.                                   |
| Public App Store                          | NO-GO   | Background guidance, spoken maneuvers, traffic-aware ETA, production service operations, and broader safety/quality evidence remain incomplete.                                                        |

The right next launch is a small **internal TestFlight technical beta**, not a public navigation release.

## Blocking requirements

### P0: required before any TestFlight invite

- [x] Deploy `https://navoss-api.yassin.app` with self-hosted Alberta Valhalla/Nominatim, indexed Calgary business/parcel search, public OpenFreeMap rendering, and official Calgary camera data.
- [x] Send search in a JSON POST body; disable routine access logging; enforce seven-day host logs and 14-day report-database backups; publish the verified policy.
- [x] Configure App Store Connect app `NavOSS`, Apple ID `6792619727`, EAS production origin, distribution certificate, provisioning profile, and Submit ID.
- [x] Verify the public privacy/support URLs and the Metro-independent production export.
- [x] Validate matched-road heading-up navigation, persistent north-up compass override, local-only map presets/content controls, and route-color choices in the iOS simulator.
- [x] Build and upload store-signed `0.1.0 (5)` from commit `21e17c1` through EAS; Apple accepted the binary for processing.
- [ ] Classify Cloudflare/OpenFreeMap map and network metadata, then reconcile App Store Connect App Privacy, `PrivacyInfo.xcprivacy`, SDK manifests, and the hosted policy.
- [ ] Complete the account-holder age-rating, content-rights, and export-compliance decisions.
- [ ] Install build 5 from TestFlight after processing, disconnect Metro/the Mac, and repeat the physical-device smoke test.

### P1: required before external testers

- Run at least a 24-hour backend soak with readiness monitoring, TLS renewal monitoring, latency/error alerts, and a rollback procedure.
- Complete the manual Apple/Google worksheet in `docs/testing/route-quality.md`; investigate every safety, legality, endpoint, or major road-choice discrepancy.
- Run passenger-operated on-road tests across downtown, Deerfoot Trail, Stoney Trail, complex interchanges, weak-GPS areas, destination arrival, rerouting, and camera approaches.
- Add crash diagnostics or document the privacy-preserving alternative and support triage process.
- Confirm map/search/routing data attribution and production usage rights in the shipped UI and hosted legal pages.
- Add manual Calgary origin selection or a clearly visible route-preview path so Beta App Review can exercise routing from outside Calgary.
- Activate and externally test `navoss@yassin.app` delivery and reply handling.
- Verify the app remains usable for the stated beta scope when the screen locks or clearly constrain the beta to foreground, screen-on testing. Current guidance is foreground-only.

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

Production build `0.1.0 (5)` was created from commit `21e17c1c1940ab38c8900d8c82602b082227ac31` as EAS build `db87e0c1-59b7-464f-833a-35ab73317af9`. EAS submission `642ea86b-356a-4fe1-89b9-4a1c4ac9a7b3` uploaded it successfully, and Apple accepted the binary for processing. CarPlay source and entitlement flags were unset, and the resolved iOS configuration contained no CarPlay entitlement.

The `preview` profile is an ad hoc production-like build, not TestFlight. Use the `production` profile for a store-signed build:

```sh
eas build --platform ios --profile production
eas submit --platform ios --profile production
```

## Internal TestFlight

1. Wait for Apple to process the uploaded build.
2. Complete encryption/export-compliance prompts and verify the processed build details.
3. Create an internal group with only App Store Connect users who are actively testing.
4. Add build 5, paste the beta description and What to Test text, and invite the smallest useful group first.
5. Install build 5 from TestFlight on a clean iPhone. Confirm the app starts without Metro, reaches the production API, requests only foreground location, searches, routes, reroutes, arrives, displays all current cameras, and submits TestFlight feedback.
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
