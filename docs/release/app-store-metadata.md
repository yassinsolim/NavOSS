# App Store Connect metadata draft

Status: **internal TestFlight preparation. Do not submit for Beta App Review or public App Review while any field below is marked pending or blocked.**

Use `docs/release/app-review.md` for the guideline-by-guideline risk assessment and `docs/release/testflight.md` for the release procedure.

## Readiness snapshot

| Item                         | Status            | Evidence or next action                                                                                                       |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Public product site          | Verified          | `https://navoss.yassin.app` returns HTTP 200 over HTTPS.                                                                      |
| Privacy URL                  | Verified internal | `/privacy` serves the July 20 provider, retention, security, and deletion policy. Direct email remains an external-beta gate. |
| Support URL                  | Verified internal | `/support` returns HTTP 200 and links to public/private GitHub channels. Add and test direct contact before external review.  |
| Source repository            | Verified public   | `https://github.com/yassinsolim/NavOSS` is public.                                                                            |
| Apple signing                | Verified ready    | EAS has the App Store distribution certificate and provisioning profile.                                                      |
| App Store Connect app record | Verified          | App `NavOSS`, bundle `org.navoss.mobile`, Apple ID `6792619727`.                                                              |
| Production API               | Verified, soaking | Public checks and 17 route variants pass; controlled reboot recovery passed. Restore/rollback and soak gates remain.          |
| Review contact               | Pending           | Test the app-specific email and enter a reachable phone number in App Store Connect.                                          |
| App Privacy answers          | Decision pending  | NavOSS-controlled retention is frozen; classify Cloudflare/OpenFreeMap map and network metadata before upload.                |
| Screenshots                  | Pending           | Capture the submitted production build after the backend and metadata are final.                                              |
| External reviewer route      | Blocked           | Add manual Calgary origin selection or a visible Calgary route-preview flow.                                                  |

## App information

| Field              | Draft                                                |
| ------------------ | ---------------------------------------------------- |
| Name               | NavOSS                                               |
| Apple ID           | `6792619727`                                         |
| Bundle ID          | `org.navoss.mobile`                                  |
| Version            | `0.1.0`                                              |
| Primary language   | English (Canada)                                     |
| Primary category   | Navigation                                           |
| Secondary category | Travel                                               |
| Subtitle           | Calgary routes, no account                           |
| SKU                | `navoss-ios-001`                                     |
| Privacy policy URL | `https://navoss.yassin.app/privacy`                  |
| Support URL        | `https://navoss.yassin.app/support`                  |
| Marketing URL      | `https://navoss.yassin.app`                          |
| Copyright          | `2026 Yassin Soliman`                                |
| Content rights     | Confirm after the provider-rights packet is complete |

Suggested keywords, under Apple's 100-character limit:

```text
navigation,Calgary,maps,routing,GPS,safety cameras,directions,route planner,open source
```

Do not add competitor names, “best,” parity claims, live traffic, CarPlay, lane guidance, background navigation, spoken maneuvers, offline routing, or exhaustive-search claims.

## Public App Store description

This copy is a future public-listing draft, not approval to submit the current technical beta.

> NavOSS helps you search for Calgary places and plan driving routes without creating an account.
>
> Search, tap a named map place, or long-press the map to choose a destination. Tapped places can show available OpenStreetMap address, hours, phone, website, and accessibility details. Compare route choices, avoid highways when needed, and follow foreground route progress with automatic rerouting and arrival detection. NavOSS also displays fixed intersection safety cameras from the official City of Calgary open dataset and provides direction-aware route-ahead notices.

> During active guidance, the map defaults to matched-road heading-up navigation so the road ahead stays at the top. Drivers can switch to north-up using the compass and can share a static ETA through the system share sheet without giving NavOSS access to Contacts. Map style, tilt, visible places/buildings/transit/cameras, and route color can be customized and are stored only on the device.
>
> NavOSS is open source and built on OpenStreetMap-derived map, search, and routing data. Attribution and data-source details are available in the app and on the NavOSS website.
>
> Current coverage is Calgary, Alberta. This version does not include live traffic, background navigation, spoken maneuver instructions, lane guidance, CarPlay, or offline routing. Data and alerts may be incomplete or outdated. Always follow posted signs, road closures, and applicable laws.

Do not use “beta,” “alpha,” “technical preview,” “test,” or “have a passenger report bugs” in the public description. If the shipped public product still requires foreground, screen-on use, state that limitation plainly rather than implying background turn-by-turn navigation.

## TestFlight beta description

Beta language belongs here, not in a public App Store listing:

> NavOSS is an account-free Calgary navigation technical beta. It provides tappable OpenStreetMap place details, Calgary place search, long-press dropped-pin routing, fastest-first route choices, avoid-highways routing, foreground GPS progress, static system-sheet ETA sharing, automatic rerouting, arrival detection, and official City of Calgary safety-camera markers and route-ahead notices.
>
> This build has no live traffic and does not provide background or spoken turn-by-turn guidance. Keep the app visible during a test trip and have a passenger operate it. Do not rely on this beta as the only navigation, road-closure, traffic, or safety source.

## What to Test

1. Search for a Calgary landmark, business, or address and report missing or incorrect results.
2. Tap visible named places such as a cafe, landmark, or gas station. Confirm the correct place sheet opens and report incorrect address, hours, phone, website, or accessibility data.
3. Use Share on a public place, then choose Reviews and confirm Google Maps opens only after that explicit action.
4. Long-press a road-accessible point on the map and confirm a dropped pin opens route choices.
5. Confirm the fastest route appears first; when ETAs match, confirm the shorter-distance route appears first.
6. Switch among Day, Night, Contrast, and Minimal map styles; confirm each is distinct, Day highways are green, and landmarks remain visible.
7. Compare the suggested route, distance, ETA, first maneuver, and major roads with current conditions.
8. Toggle Avoid highways and confirm the route changes meaningfully.
9. Start guidance with the phone mounted and a passenger operating it; check the maneuver distance and ETA tray, then use Share ETA and confirm no Contacts prompt appears.
10. Report puck jumps, incorrect maneuvers, false reroutes, missed reroutes, or early/late arrival.
11. On a lawful trip past an official camera, report missing, repeated, late, or wrong-direction notices.
12. End navigation and confirm foreground location activity stops.
13. Open About and privacy and confirm the hosted privacy and support links work.

Include the public start area, destination, local time, app build, iPhone model, and unexpected road or maneuver. Do not include a home address or precise personal trip history unless essential to reproduce a safety issue.

## App Review information

| Field            | Value                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Sign-in required | No                                                                                               |
| Demo credentials | None; the app has no account system                                                              |
| Contact name     | Yassin Soliman                                                                                   |
| Contact email    | Pending successful external delivery/reply test for `navoss@yassin.app`                          |
| Contact phone    | Pending; enter a phone that Apple can reach during review and do not commit it to the repository |
| Notes            | Use the reviewed template below only after every bracketed item has been resolved                |

### Notes for Review template

Do not paste this template into App Store Connect until the production build and reviewer-access path are complete.

> NavOSS is an account-free navigation app with coverage intentionally limited to Calgary, Alberta, Canada. No sign-in, purchase, subscription, or demo credential is required.
>
> To review search, tap Search Calgary, enter “Calgary Tower,” and select the result. To review routing from outside Calgary, [insert exact manual-origin or visible route-preview steps and labels]. The route preview shows distance, estimated time, route geometry, and the Avoid highways preference. Physical GPS progress, rerouting, arrival, and route-ahead camera notices require movement along the selected Calgary route.
>
> The app requests precise location only while open. It uses location for map position, route origin, route matching, rerouting, arrival detection, and direction-aware official safety-camera notices. It does not request background location. Search and map browsing remain available when location is denied; current-position routing and active navigation do not.
>
> NavOSS has no live traffic, background navigation, spoken maneuver guidance, lane guidance, CarPlay, advertising, analytics, tracking, account system, or in-app purchases. Search and route payloads are processed for each response and then discarded. Routine HTTP access logging is disabled; NavOSS operational/security logs retain no more than seven days and exclude request bodies. Cloudflare and OpenFreeMap practices are linked from the privacy policy.
>
> Fixed camera records come from the Calgary Police Service Intersection Safety Cameras dataset published through Calgary Open Data. Notices are informational, direction-filtered, and supplementary to posted signs and laws. Map/search/routing data is OpenStreetMap-derived with visible attribution.
>
> Production service status during review: [insert monitored URL and escalation owner]. Support: `https://navoss.yassin.app/support`. Privacy: `https://navoss.yassin.app/privacy`.

The current app has no AI feature or AI provider. App Store Connect has no general “AI-authored code” disclosure field. Do not add an irrelevant AI statement to the review notes. If runtime behavior changes, reassess Guideline 5.1.2(i) before submission.

## App Privacy decision table

Production recipients and retention are now documented. Do not submit final answers until the account holder classifies direct OpenFreeMap requests and Cloudflare network/security processing. Apple defines collection as off-device transmission that lets the developer or a partner access data longer than needed to service the request in real time.

| Data type              | Current behavior                                                                                                                                                                                                                                                                            | Final answer gate                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Precise Location       | Route/reroute coordinates transit Cloudflare to operator-hosted Valhalla and are discarded after each response. Active matching is on device. Direct map tile identifiers can describe the current view.                                                                                    | Route payloads meet Apple's Not Collected real-time exception. Classify the direct map path conservatively from OpenFreeMap/Cloudflare retention before upload.                      |
| Coarse Location        | Optional search origin is discarded after each response. IP addresses and requested map resources are processed by infrastructure providers.                                                                                                                                                | Search payloads meet the real-time exception. Decide whether provider-retained network/map metadata requires Location or Other Diagnostic Data for App Functionality.                |
| Search History         | Search text, or a tapped public place name and map coordinate, is sent in a JSON body to operator-hosted Nominatim and a local Calgary public-data index, then discarded after each response; the index stores source records, not queries, and tested values are absent from logs/backups. | Not Collected under Apple's real-time-service definition unless request tracing, persistence, or provider settings change.                                                           |
| Device ID              | No advertising ID, app user ID, or device-level identifier is created. Cloudflare/OpenFreeMap necessarily receive an IP address in transit.                                                                                                                                                 | Apple says retained IP addresses must be classified according to use, potentially as Device ID, location, or diagnostics. The account holder must make this provider-level decision. |
| Customer Support       | Users may choose GitHub Issues, private vulnerability reporting, TestFlight feedback, or the planned support email.                                                                                                                                                                         | Reassess after the final in-app support path is fixed. Optional customer-support disclosure applies only when all of Apple's criteria are met.                                       |
| Crash/Performance Data | No crash, analytics, APM, or uptime SDK is integrated. Host logs are bounded and exclude routine HTTP access events and payloads.                                                                                                                                                           | No app-originated Crash/Performance collection now. Reassess before adding telemetry or diagnostics.                                                                                 |
| User ID                | No account or user ID exists.                                                                                                                                                                                                                                                               | No, unless a future service introduces an account-level or persistent identifier.                                                                                                    |
| Purchases              | No commerce or StoreKit flow exists.                                                                                                                                                                                                                                                        | No.                                                                                                                                                                                  |
| Contacts               | Not accessed. Place and ETA sharing use Apple's system share sheet; NavOSS does not receive Apple's suggested-recipient list.                                                                                                                                                               | No. Keep `NSContactsUsageDescription` absent unless this architecture changes.                                                                                                       |
| Photos, Videos, Audio  | Not accessed or collected.                                                                                                                                                                                                                                                                  | No.                                                                                                                                                                                  |
| Tracking               | No ads, data broker, cross-app linking, or tracking SDK exists.                                                                                                                                                                                                                             | No, provided production providers do not repurpose data for tracking.                                                                                                                |

Any data type that is ultimately disclosed should use only its real purpose. The current expected purpose is App Functionality, not advertising, marketing, analytics, personalization, or tracking.

The conservative unresolved option is to disclose provider-retained map/network data as Location and/or Other Diagnostic Data for App Functionality, with no tracking. Whether it is linked depends on the account holder's final interpretation of temporary IP/security records and current provider terms.

The generated app privacy manifest currently declares no collected data and no tracking. Keep that only if the production real-time discard facts support it; otherwise update the app-level manifest and App Store Connect together. Embedded SDK manifests must also be present and accurate.

## Location and permissions

Current iOS purpose string:

> NavOSS uses your precise location while the app is open to show your position, provide navigation, reroute, detect arrival, and warn about official safety cameras ahead.

Before upload, confirm the signed archive has:

- foreground When In Use location only;
- no background location usage description or background location mode;
- no unrelated permission strings;
- no Contacts usage description or Contacts authorization request;
- permission requested only when the user invokes location-dependent functionality; and
- graceful denial/revocation behavior with search and map browsing still available.

## Age rating inputs

The legal owner must complete Apple's current questionnaire in App Store Connect. Use actual behavior, not a desired rating. Current factual inputs include:

- no user-generated content displayed inside the app;
- no advertising;
- no gambling, contests, loot boxes, or purchases;
- no alcohol, tobacco, drug, sexual, horror, violence, or medical content;
- no anonymous chat or messaging;
- no unrestricted web browser; fixed privacy, support, official-site, and user-invoked Reviews links open external pages;
- foreground location use for navigation; and
- official fixed safety-camera information without reckless-driving rewards or evasion features.

An Unrated app cannot be published.

## Encryption and export compliance

The app currently sets `ITSAppUsesNonExemptEncryption` to `false`. The intended basis is that NavOSS implements no proprietary cryptography and relies on standard HTTPS/TLS provided by the operating system and networking stack.

The account holder must still answer Apple's export-compliance questions from the submitted binary and distribution territories. Do not treat the Info.plist value as legal advice or as a substitute for that determination. Reassess if custom cryptography, a VPN, encrypted messaging, or security functionality is added.

## Screenshot plan

Apple currently accepts one to ten screenshots per device size in PNG or JPEG without transparency. Because the app is iPhone-only, capture the highest-resolution iPhone portrait set requested by the current App Store Connect record and let App Store Connect scale it where permitted.

Recommended order:

1. Calgary map, account-free search, and production service online.
2. Useful Calgary search results for a public landmark.
3. Route preview with ETA, distance, geometry, and route choice.
4. Avoid highways preference with a visibly different valid route.
5. Active foreground guidance with a clear maneuver and public roads.
6. Official safety-camera marker or route-ahead notice, with City attribution visible where practical.
7. Arrival state.

Use the exact submitted production build. Use fictional or public locations. Do not show simulator chrome, development labels, reserved endpoints, personal addresses, private notifications, competitor UI, competitor logos, traffic claims, or unimplemented functionality. Screenshots must show the app in use rather than only the icon, splash screen, or title art.

## TestFlight versus public wording

| Topic                  | TestFlight                             | Public App Store                                                                               |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Beta/technical status  | State clearly                          | Remove; public binaries must be complete rather than beta/trial versions                       |
| What to Test           | Detailed tester tasks and evidence     | Not part of customer-facing description                                                        |
| Passenger operation    | Appropriate safety testing instruction | Describe safe use without presenting the listing as a test program                             |
| Known limitations      | Explicit and detailed                  | Keep material product limitations accurate and concise                                         |
| Missing features       | Useful for testers                     | Never imply those features exist; mention only limitations needed to set customer expectations |
| Competitor comparisons | Manual testing worksheet only          | No names, logos, parity claims, or keyword stuffing                                            |

## Submission blockers

- [x] Create the App Store Connect app record and add its numeric Apple ID to `submit.production.ios.ascAppId`.
- [x] Deploy the production API and production-capable providers.
- [ ] Complete the 24-hour soak, PostgreSQL restore, and graph/index rollback exercises.
- [ ] Add a reviewer-accessible manual Calgary origin or visible route preview before Beta App Review.
- [x] Freeze NavOSS-controlled data flows, providers, regions, logs, retention, backups, and deletion behavior.
- [x] Publish and verify the internal-beta privacy policy and support paths.
- [ ] Activate and test `navoss@yassin.app` from an external sender through a successful reply.
- [ ] Reconcile App Privacy answers, app/SDK privacy manifests, permission strings, and network captures.
- [ ] Complete age-rating, content-rights, and export-compliance questions.
- [ ] Enter reachable App Review contact details.
- [ ] Capture and validate production screenshots.
- [ ] Install the processed build from TestFlight without Metro and pass the clean-device smoke test.
