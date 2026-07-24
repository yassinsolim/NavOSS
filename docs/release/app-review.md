# App Review readiness

Assessment date: 2026-07-24

Status: **NO-GO for external TestFlight or App Store review.** Prepare a small internal TestFlight only after the P0 internal-build gates below pass.

This is an engineering and submission-readiness assessment, not legal advice. Apple can update its rules or apply additional scrutiny. Recheck the linked first-party guidance immediately before submission.

## Bottom line

NavOSS does not face a special App Review rule because AI tools may have assisted its development. Apple reviews the submitted app, its behavior, metadata, data handling, safety, rights, and compliance. The current App Review Guidelines do not prohibit AI-authored code.

Guideline 5.1.2(i) does require an app to disclose where personal data is shared with third parties, explicitly including third-party AI, and to obtain permission before that sharing. NavOSS currently has no user-facing AI feature, AI SDK, model endpoint, or runtime path that sends user data to an AI provider. Do not add an irrelevant AI claim or explanation to the listing or review notes. Reassess 5.1.2(i) before shipping any future AI search, support, telemetry-triage, or route feature.

The present rejection risks are concrete:

1. The production backend is live, passes its release checks, and recovered from a controlled VM reboot, but it has not completed the required soak, PostgreSQL restore, or graph/index rollback exercises.
2. Search and route requests are discarded after servicing, and NavOSS host logs are bounded, but App Store Connect still needs an account-holder decision for Cloudflare/OpenFreeMap network and map-request data.
3. The reviewer-access blocker is resolved: a visible Calgary Tower preview uses the production route API, is documented in review notes, and disables Start until real-location routing is restored.
4. The support email is not verified, App Privacy/age-rating/export-compliance answers are unfinished, and production screenshots are not captured.

## Distribution decision

| Channel                         | Current verdict        | Meaning                                                                                                                       |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Local and physical-device alpha | GO                     | Existing automated and device checks can continue.                                                                            |
| Internal TestFlight             | NO-GO pending P0 gates | Signed build 13 is uploaded; Apple processing, account-holder fields, and clean physical-device/CarPlay validation remain.    |
| External TestFlight             | NO-GO                  | Reviewer access is complete; Beta App Review, final beta information, backend soak, support, and on-road evidence remain.     |
| Public App Store                | NO-GO                  | A beta build and beta metadata do not belong on the public App Store. Reliability and public-release scope remain incomplete. |

Internal TestFlight is a distribution step, not an exemption from the App Review Guidelines. Any build intended for public distribution should already be honest, safe, and privacy-compliant.

## Verified evidence

The following statements are supported by the current app, repository, or live services:

- Bundle ID `org.navoss.mobile`, version `0.1.0`, When in Use authorization, and active-navigation `location` background mode are present.
- Signed build `0.1.0 (13)` and its provisioning profile assert the Apple-approved `com.apple.developer.carplay-maps` entitlement; its CarPlay template scene is present and the deprecated Maps entitlement is absent.
- The location purpose string names map position, navigation, rerouting, arrival, and official safety-camera warnings.
- No account, login, purchase, subscription, advertising SDK, analytics SDK, tracking SDK, or runtime AI dependency is present in the mobile package.
- The app exposes in-app links to the privacy and support pages; the focused Maestro flow passes both below- and above-fold assertions.
- `https://navoss.yassin.app`, `/privacy`, and `/support` return HTTP 200 over HTTPS.
- The source repository is public at `https://github.com/yassinsolim/NavOSS`.
- The app visibly attributes OpenStreetMap, OpenMapTiles, and City of Calgary data and provides a MapLibre attribution control.
- Safety-camera locations come from the Calgary Police Service dataset published through Calgary Open Data. The app does not label crowdsourced reports as official data.
- Normal Fastify request logging is disabled, and application errors log names and request IDs rather than request bodies.
- The app uses public Expo, React Native, iOS, and MapLibre APIs. No private iOS API use has been identified.
- Apple Developer membership, bundle registration, distribution certificate, and App Store provisioning credentials are ready through EAS.
- `https://navoss-api.yassin.app` serves the production API through Cloudflare Tunnel with self-hosted Alberta Nominatim and Valhalla providers.
- `/ready` checks routing and hybrid search dependencies. Production search combines the local Calgary business/parcel index with self-hosted Nominatim and returns `calgary-hybrid-search`; all 57 official Calgary camera records load publicly.
- The deployed Calgary route-quality gate passes 17 of 17 variants with 73 ms p95 API latency.
- Search uses a JSON POST body; routine HTTP access logs are disabled at Fastify, Caddy, and Nominatim, and tested search/route values are absent from the host journal.
- All six containers use journald with a seven-day/512 MiB limit; SSH and firewall logs rotate within seven days, report-database backups retain 14 days, and reproducible public search-index tables are excluded from those backups.
- The production EAS environment and a Metro-independent iOS export use `https://navoss-api.yassin.app` with no retired, localhost, or LAN endpoint.

These facts establish the current origin and host posture. Cloudflare/OpenFreeMap App Privacy classification, long-duration service behavior, recovery drills, and physical-device evidence remain separate gates.

## Review risk matrix

Risk describes the current chance of delay or rejection if this build were submitted now.

| Guideline                                                  | Risk                                          | Current posture                                                                                                                                                                                                 | Required evidence or change                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.4 Physical Harm                                          | High                                          | Navigation and camera notices can affect driving decisions. Camera alerts are informational and the UI says to follow signs and laws.                                                                           | Complete passenger-operated road tests; reject illegal or dangerous maneuvers; keep safety text visible; document incident triage and stop-rollout criteria. Never imply the app is an emergency or autonomous-driving system.                                                                 |
| 1.4.4 DUI checkpoints/reckless driving                     | Medium                                        | NavOSS does not display DUI checkpoints. Its fixed safety cameras are from an official law-enforcement dataset.                                                                                                 | Keep official provenance and monthly freshness evidence. Avoid “speed trap,” evasion, points, rankings, or language that encourages speeding. If checkpoint data is ever added, accept only law-enforcement-published records.                                                                 |
| 1.4.5 Unsafe device use                                    | Medium                                        | Current beta instructions say the phone should be mounted and operated by a passenger while moving.                                                                                                             | Keep interactions minimal during guidance. Do not market handheld interaction while driving. Verify route and end-navigation controls remain usable without obstructing the map.                                                                                                               |
| 1.5 Developer Information                                  | High                                          | Public support page exists, but it currently routes users to GitHub and the planned email alias is not tested.                                                                                                  | Activate and test `navoss@yassin.app`; add accurate review contact name, phone, and email; keep an easy contact path in both the app and Support URL.                                                                                                                                          |
| 1.6 Data Security                                          | Medium                                        | HTTPS terminates at Cloudflare; the origin uses an outbound tunnel, key-only SSH, default-deny firewall, least-privilege containers, redacted PostgreSQL errors, and seven-day logs.                            | Complete reboot/restore/rollback drills, document incident response, and recheck Cloudflare account settings before external testing.                                                                                                                                                          |
| 2.1 App Completeness                                       | Medium                                        | The production API, search, routing, and camera paths are live. A visible preview-only Calgary Tower origin lets a reviewer outside coverage exercise real route alternatives without simulating live guidance. | Complete the backend soak and test the exact store build without Metro or the development Mac. Keep the preview-only label and disabled Start behavior intact.                                                                                                                                 |
| 2.2 Beta Testing                                           | High for public submission                    | Technical-beta language is appropriate in TestFlight but not in a public App Store binary or listing.                                                                                                           | Use the beta description only in TestFlight. Remove “beta,” “alpha,” “technical preview,” placeholder, and test-only instructions from public metadata and production UI before App Store review.                                                                                              |
| 2.3 Accurate Metadata                                      | High                                          | The draft avoids traffic and parity claims, but screenshots and final descriptions do not yet exist.                                                                                                            | Capture the submitted production build in use. Show only implemented features. State Calgary coverage and no live traffic. Do not claim competitor parity, exhaustive search, lane guidance, or offline routing. Mention background guidance and CarPlay only for the validated CarPlay build. |
| 2.3.1 Review Notes                                         | High                                          | Non-obvious coverage, camera direction filtering, background navigation, and CarPlay need specific instructions.                                                                                                | Provide exact taps, a deterministic Calgary route, coverage limits, account-free access, backend status, camera provenance, location behavior, and CarPlay search/start steps. Do not hide or omit a demo feature.                                                                             |
| 2.3.3 Screenshots                                          | High                                          | No production product-page set exists.                                                                                                                                                                          | Upload one to ten opaque PNG/JPEG images. Use real app screens, fictional/public locations, and no simulator, dev-server, reserved-endpoint, or competitor imagery. Validate against App Store Connect's current accepted dimensions.                                                          |
| 2.3.5/2.3.6 Category and age rating                        | Medium                                        | Navigation is the intended primary category. The legal owner has not completed the current age-rating questionnaire.                                                                                            | Use Navigation as primary. Answer every current questionnaire item from actual behavior; do not guess a rating in repository metadata. The app cannot publish while Unrated.                                                                                                                   |
| 2.5.1 Public APIs                                          | Low                                           | Dependencies use public platform APIs; the native navigation module is ordinary Swift/Expo code.                                                                                                                | Run App Store upload validation and inspect any API-use warnings. Keep the generated native project and dependencies on supported SDK versions.                                                                                                                                                |
| 2.5.4 Background services                                  | Medium                                        | The dedicated CarPlay build declares location background mode and starts it only for active navigation under When in Use authorization, with the iOS indicator visible.                                         | Verify lock/unlock, force-quit limits, battery behavior, End/arrival cleanup, signed `UIBackgroundModes`, and purpose-string/privacy consistency on a physical device.                                                                                                                         |
| 2.5.5 IPv6-only operation                                  | Medium                                        | Production calls use HTTPS hostnames and the release export contains no embedded IP address, but NAT64 testing is not complete.                                                                                 | Test the submitted build on an IPv6-only/NAT64 network. Ensure API, tiles, fonts, sprites, search, routing, and camera dependencies remain reachable through DNS.                                                                                                                              |
| 4.1 Copycats                                               | Low if metadata stays original                | NavOSS has its own name, chevron mark, visual system, code, and data pipeline. Early product intent referenced Waze-like functionality, which must not become public copying or metadata.                       | Do not use competitors' names, icons, screenshots, UI replicas, or parity claims in the app or listing. Open source status does not excuse copied branding or interaction design.                                                                                                              |
| 4.2 Minimum Functionality                                  | Low                                           | This is a native map/navigation app with search, route alternatives, GPS progress, native route matching, rerouting, arrival, and official camera alerts, not a web wrapper.                                    | Preserve an app-like first-run experience and demonstrate the core flow in review. A backend outage that leaves only a map shell can turn this into a 2.1/4.2 issue.                                                                                                                           |
| 4.3 Spam                                                   | Medium for future city expansion              | A Calgary-only first release is one bundle. Apple's rule specifically warns against a separate map app for each city.                                                                                           | Expand coverage inside `org.navoss.mobile`; do not create city-specific clone bundle IDs. Keep the listing useful and differentiated from generic map templates.                                                                                                                               |
| 5.1.1 Privacy Policy                                       | High                                          | The hosted July 20 policy names providers, processing, host retention, deletion limits, international processing, security, and the inactive direct-email limitation.                                           | Activate direct private contact before external testing and keep the policy synchronized with final App Privacy answers.                                                                                                                                                                       |
| 5.1.1 Permission and minimization                          | Medium                                        | Precise When in Use location is core to navigation; active navigation continues in the background with visible system indication. Search and map browsing remain usable without location.                       | Verify denial and revocation behavior. Start background activity only after the user starts navigation or opens CarPlay, stop it on End/arrival, and continue avoiding Always authorization and unrelated permissions.                                                                         |
| 5.1.2(i) Data sharing, including AI                        | Medium for providers; no AI-specific exposure | Search/routing are operator-hosted and discarded after each response. Cloudflare handles API traffic; the phone requests map resources directly from OpenFreeMap. No data goes to AI.                           | Enter conservative, consistent App Privacy answers for provider-controlled network/map data. Reassess and obtain permission before any future third-party AI receives personal data.                                                                                                           |
| 5.1.5 Location Services                                    | High                                          | Location directly supports navigation and is not used for emergency service or autonomous vehicle control. During active guidance it continues while locked or connected to CarPlay.                            | Keep App Store privacy answers, policy, purpose string, background mode, and app behavior consistent. Document precise-location transmission and verify stopping guidance or arrival stops updates and erases the transient route.                                                             |
| 5.2.1/5.2.2 Intellectual Property and third-party services | Medium                                        | OSM/City attribution is visible; Nominatim/Valhalla are self-hosted; OpenFreeMap permits public-instance and commercial use and requires attribution. Proprietary competitors are not scraped.                  | Preserve dated provider terms and licenses in the rights packet, confirm the shipped attribution, and keep a self-hosting fallback for public tile-service or SLA changes.                                                                                                                     |

## AI rule, precisely

The relevant sentence is in Guideline 5.1.2(i), not a rule against AI-made apps. It says that personal-data sharing with third parties, “including with third-party AI,” must be clearly disclosed and explicitly permitted before sharing.

For this release:

- There is no AI feature to describe in App Store metadata.
- There is no runtime AI SDK or AI provider to list as a data recipient.
- The review notes should not discuss development tools unless Apple asks a direct question.
- Source-code authorship does not replace the developer's responsibility for correctness, licenses, privacy, export compliance, or review responses.
- Adding AI later requires a new data-flow review even if the model is used only for support-ticket summaries or diagnostics.

## Privacy decision record

Apple defines “collect” for the Privacy Nutrition Label as transmitting data off device in a way that allows the developer or a third-party partner to access it longer than necessary to service the request in real time. Data processed only on device is not collected. Data sent to service a request and immediately discarded after the request also does not need to be disclosed in App Store Connect under Apple's current guidance.

Production tests now prove immediate discard for search and route payloads on the NavOSS-controlled stack. Provider-controlled map and network metadata still needs a written App Store Connect decision:

| Path                                         | Data leaving device                                       | Recipient                                                                                                           | Decision required                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search                                       | Search text and optional approximate search origin        | Cloudflare transit; operator-hosted API, Nominatim, and local Calgary public-data index                             | Sent in a JSON body, processed in memory, and discarded after the response. The public-data index is refreshed independently and stores no queries. Tested values are absent from logs and backups; classify as Not Collected under Apple's real-time-service definition unless provider settings change. |
| Initial route                                | Precise origin and destination coordinates                | Cloudflare transit; operator-hosted API and Valhalla; optional licensed Mapbox traffic only when explicitly enabled | Processed in memory and discarded after the response; tested coordinates are absent from logs and backups. Classify as Not Collected under the current real-time-service definition unless provider settings or retention change.                                                                         |
| Reroute                                      | Latest precise route origin and destination               | Same as routing                                                                                                     | Uses the same transient body-only path and retention controls. Licensed Mapbox traffic must remain disabled until provider/privacy answers, attribution, and physical validation are complete.                                                                                                            |
| Active route matching and camera eligibility | Precise samples                                           | On device in the current architecture                                                                               | No App Privacy disclosure solely for on-device processing. Reassess if telemetry or server matching is added.                                                                                                                                                                                             |
| Map rendering                                | IP address and requested tile/style/font/sprite resources | OpenFreeMap and its infrastructure providers                                                                        | OpenFreeMap normally omits IPs but keeps anonymized logs and may retain incident IP logs for 30 days. The account holder must choose a conservative Location/Diagnostics classification before upload.                                                                                                    |
| Camera feed                                  | No user location; normalized camera request               | Cloudflare transit and NavOSS API                                                                                   | Calgary Open Data is contacted only by the server. Routine request logging is disabled and the phone does not send location to Calgary Open Data.                                                                                                                                                         |
| Support                                      | User-chosen issue text and attachments                    | GitHub and/or support email provider                                                                                | Disclose in the policy. App Privacy treatment depends on the final in-app collection path and whether Apple's optional customer-support criteria are all met.                                                                                                                                             |
| Crash/operations tooling                     | No crash/analytics SDK; bounded service/security logs     | NavOSS host and Cloudflare network security                                                                         | Host logs retain seven days and exclude routine access events and payloads. Reassess before adding crash, APM, uptime-beacon, or performance tooling to the app.                                                                                                                                          |

The generated app privacy manifest currently declares no collected data and no tracking while listing required-reason API access. Treat this as provisional. App Store Connect answers, the app-level privacy manifest, embedded SDK manifests, the hosted policy, and actual production behavior must tell one consistent story.

## Provider-rights packet

Prepare one review folder containing:

- OpenStreetMap ODbL terms and attribution requirements;
- OpenFreeMap/OpenMapTiles production-use, tile, style, sprite, glyph, and attribution terms, or equivalent self-hosting evidence;
- MapLibre license and the shipped third-party notices;
- self-hosted Valhalla and Nominatim licenses, deployment ownership, and OSM attribution;
- Calgary Open Data Terms of Use; business dataset `vdjc-pybd`, parcel-address dataset `s8b3-j88p`, camera dataset `dv2f-necx`; filtering/update behavior; and current source snapshot dates;
- proof that NavOSS does not scrape Apple Maps, Google Maps, Waze, or another proprietary navigation service; and
- the public repository license map and third-party notices.

A link working technically is not evidence of production usage rights.

## Reviewer access requirement

Before external TestFlight, choose and test one honest path:

1. Complete: a clearly visible, documented Calgary route-preview mode uses Calgary Tower as the origin and the same production route response/UI. It is available after current-location routing fails, is not hidden behind a review-only flag, and disables Start until the user returns to real-location routing.
2. Future enhancement: add general manual origin search so any user can choose a start and destination without changing device location.

Review notes alone are insufficient because the current route path always requests current location. A reviewer in California or another country may otherwise receive an out-of-coverage route failure and reasonably treat the app as incomplete.

The reviewer path does not need to fake live GPS navigation. Notes should distinguish route preview from on-road progress and explain what requires physical movement in Calgary.

## P0 internal TestFlight gate

All items are required before inviting internal testers:

- [x] Create the App Store Connect app record for `org.navoss.mobile` and record Apple ID `6792619727`.
- [x] Add `submit.production.ios.ascAppId` to `apps/mobile/eas.json`.
- [x] Deploy `https://navoss-api.yassin.app` with production-capable map, search, routing, and camera dependencies.
- [x] Pass `/health`, `/ready`, `/v1/config`, mobile `validate:release`, and release export checks against that origin.
- [x] Decide every NavOSS-controlled processing region, access/security-log field, retention period, backup period, and deletion path.
- [x] Publish and verify the July 20 privacy policy and existing support/data-source pages.
- [ ] Reconcile App Store Connect App Privacy, the app privacy manifest, SDK manifests, and the hosted policy.
- [ ] Complete the current age-rating and export-compliance questions accurately.
- [ ] Build with the production EAS profile, inspect the signed archive, and upload it.
- [ ] Install the processed build from TestFlight on a clean iPhone with Metro and the development Mac unavailable.
- [ ] Repeat search, route, foreground permission, reroute, arrival, camera, attribution, legal-link, offline, and service-recovery smoke tests.

## P0 external TestFlight gate

In addition to the internal gate:

- [x] Add and test the visible Calgary Tower route-preview path from an outside-coverage simulator location.
- [ ] Activate and externally test `navoss@yassin.app` delivery and reply handling.
- [ ] Complete a minimum 24-hour backend soak with alerts and rollback.
- [ ] Complete passenger-operated Calgary road tests and the manual Apple/Google comparison worksheet.
- [ ] Prepare Beta App Review contact information, notes, privacy URL, beta description, and What to Test.
- [ ] Keep the review backend and monitoring staffed throughout Beta App Review.
- [ ] Start with a named cohort rather than a public TestFlight link.

## Public App Store gate

Do not submit the technical beta copy as a public app version. Before public review:

- remove beta/alpha/test language from the binary and public metadata;
- use only claims demonstrated by the submitted build;
- capture a production screenshot set from public or fictional Calgary locations;
- provide reliable public navigation scope, support operations, route-quality evidence, and clear traffic/background limitations;
- validate locked-phone background guidance, spoken prompts, and End/arrival cleanup on the submitted physical-device build; and
- use manual release after approval so approval does not immediately publish an unmonitored service.

## Recommended submission order

1. Freeze providers, rights, logging, retention, and support ownership.
2. Deploy and soak the production API; do not build while its hostname is absent.
3. Create the App Store Connect record and finish app-level information.
4. Reconcile privacy policy, label, manifest, permission strings, and actual network captures.
5. Build and upload one production-profile binary.
6. Run a clean internal TestFlight installation and 48-hour soak.
7. Add reviewer-accessible Calgary route planning, then submit the proven build to external Beta App Review.
8. Prepare separate non-beta metadata and screenshots only after the public-release functionality gate passes.

## First-party references

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Overview of submitting for review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)
- [Upload app previews and screenshots](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Set an app age rating](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating)
- [Overview of export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
