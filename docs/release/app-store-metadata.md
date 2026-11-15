# App Store Connect metadata draft

Status (refreshed 2026-11-15): **TestFlight technical beta.** Build `0.1.0 (82)` was distributed at 23:18 UTC; App Store Connect shows Testing for NavOSS Friends and internal `testers`. Its TestFlight description was updated for build 82. The production service covers Canada for search and routing and returns lanes and signposts when available. Reports are `attested` and traffic is `collect`; traffic is not displayed or used in routes. Public App Review remains subject to the applicable gates below.

- Builds 80, 81 and 82 carry App Attest and the Google place panel; builds before 80 cannot share reports or traffic. As of 16:52 UTC on 2026-11-15 no installation had registered.
- Live traffic remains unavailable. The production offline manifest publishes All Alberta and Calgary-area regions; BC has no offline region. A physical iPhone download in build 80 remains unverified.

Use `docs/release/app-review.md` for the guideline-by-guideline risk assessment and `docs/release/testflight.md` for the release procedure.

## Readiness snapshot

| Item                         | Status               | Evidence or next action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public product site          | Verified             | `https://navoss.yassin.app` returns HTTP 200 over HTTPS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Privacy URL                  | Verified internal    | `/privacy` serves the July 24 provider, retention, security, deletion, and optional Google SDK policy. Direct email remains an external-beta gate.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Support URL                  | Verified internal    | `/support` returns HTTP 200 and links to public/private GitHub channels. Add and test direct contact before external review.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Source repository            | Verified public      | `https://github.com/yassinsolim/NavOSS` is public.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Apple signing                | Verified ready       | EAS has the App Store distribution certificate and provisioning profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| App Store Connect app record | Verified             | App `NavOSS`, bundle `org.navoss.mobile`, Apple ID `6792619727`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Production API               | Verified, soaking    | Public checks and 17 route variants pass; controlled reboot recovery passed. Restore/rollback and soak gates remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Review contact               | Pending              | Test the app-specific email and enter a reachable phone number in App Store Connect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| App Privacy answers          | Published 2026-11-15 | Eight data types, none used for tracking: Precise Location (linked; App Functionality, Analytics), Coarse Location (not linked; App Functionality, Analytics), Device ID (linked; App Functionality, Analytics), Other User Content (linked; App Functionality), Other Data Types (linked; Analytics), Search History (not linked; Analytics, App Functionality), Product Interaction (not linked; Analytics), Performance Data (not linked; Analytics). They cover community sharing and the Google place panel; re-check them whenever a build changes what is collected. |
| Screenshots                  | Pending              | Capture the submitted production build after the backend and metadata are final.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| External reviewer route      | Verified (build 17)  | The visible Calgary Tower route preview exists (see `app-review.md`); re-verify it on the next candidate after the phone UI refresh.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

Do not add competitor names, “best,” parity claims, claims of live traffic or exhaustive-search claims. Describe offline routing only for builds and regions that support it. Mention lanes and signposts only when the server returns them, and CarPlay, background navigation, and spoken guidance only for a build that includes those capabilities.

## Public App Store description

This copy is a future public-listing draft, not approval to submit the current technical beta.

> NavOSS helps you search for Calgary places and plan driving routes without creating an account.
>
> Search, tap a named map place, or long-press the map to choose a destination. Tapped places can show available OpenStreetMap address, hours, phone, website, and accessibility details. Compare route choices, avoid highways when needed, and follow turn-by-turn guidance with spoken maneuvers, background continuation, automatic rerouting, arrival detection, and CarPlay. NavOSS also displays fixed intersection safety cameras from the official City of Calgary open dataset and provides direction-aware route-ahead notices.

> During active guidance, the map defaults to matched-road heading-up navigation so the road ahead stays at the top. Drivers can switch to north-up using the compass and can share a static ETA through the system share sheet without giving NavOSS access to Contacts. Map style, tilt, visible places/buildings/transit/cameras, and route color can be customized and are stored only on the device.
>
> NavOSS is open source and built on OpenStreetMap-derived map, search, and routing data. Attribution and data-source details are available in the app and on the NavOSS website.
>
> Current backend search and routing coverage includes Canada. Lane guidance and signposts appear when the service returns them. There is no live traffic. All Alberta and the Calgary area are available for offline download; British Columbia has no offline region. Data and alerts may be incomplete or outdated. Always follow posted signs, road closures, and applicable laws.

Do not use “beta,” “alpha,” “technical preview,” “test,” or “have a passenger report bugs” in the public description. If the shipped public product still requires foreground, screen-on use, state that limitation plainly rather than implying background turn-by-turn navigation.

## TestFlight beta description

Beta language belongs here, not in a public App Store listing:

> NavOSS is an account-free navigation technical beta. Its backend provides place search and routing across Canada. Build 82, distributed to testers on November 15, 2026, includes spoken turn-by-turn guidance, locked-phone background continuation, CarPlay search and navigation, and a province-wide road-events list for Alberta, British Columbia and Ontario. Drivers can opt in to share road reports; verified reports appear unconfirmed until corroborated.
>
> There is no live traffic. All Alberta and the Calgary area can be downloaded for offline maps, search and routing; British Columbia has no offline region yet. Traffic speeds are collected only from drivers who opt in, for evaluation; nothing is displayed or used in routes. Keep the phone mounted and have a passenger operate controls while moving. Do not rely on this beta as the only navigation, road-closure, traffic, or safety source.

## What to Test

The following build 82 **What to Test** draft reflects the production state as of 2026-11-15. The TestFlight description was updated for build 82; this draft is not a verbatim record:

```text
Please test NavOSS 0.1.0 (82) while parked or with a passenger operating the controls.

1. Search for places and plan routes across Canada. Report missing results or incorrect routes. Some places have no connecting road route.
2. When a route provides lanes or exit signs, check that the guidance matches the road signs.
3. Open a named place and look for the Google place panel. If the nearest listing is not the right place, try "Find this place on Google" and select the correct listing.
4. If you encounter a road condition, turn on Share road reports and submit the matching report when safe. Reports from verified installations are unconfirmed until corroborated. Sharing is off by default.
5. Connect CarPlay and try search, route preview and guidance. Report any display, voice or reconnection problems.
6. Open the road-events list for Alberta, British Columbia and Ontario. 511 Alberta and Ontario 511 were connected in production on 2026-11-15.
7. Start a trip away from the road and check that the chosen route stays selected while the app acquires your position. If the app is closed before the first route match, the trip currently ends on relaunch.
8. Check long-trip estimates and road-event dates. Dates outside the current year show the year. The Alberta list shows the 100 newest events, so Edmonton events may be absent from the list even though they appear on the map.

There is no live traffic. All Alberta and the Calgary area are available for offline download; British Columbia has no offline region. A download on a physical iPhone still needs verification. Optional traffic sharing is collected for evaluation only; nothing is displayed or used in routes. Do not rely on this beta as your only source for navigation or safety.

In feedback, include the build, iPhone model and a public area or road if useful. Do not include a home address or precise personal trip history.
```

## App Review information

| Field            | Value                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Sign-in required | No                                                                                               |
| Demo credentials | None; the app has no account system                                                              |
| Contact name     | Yassin Soliman                                                                                   |
| Contact email    | Pending successful external delivery/reply test for `navoss@yassin.app`                          |
| Contact phone    | Pending; enter a phone that Apple can reach during review and do not commit it to the repository |
| Notes            | Use the reviewed template below only after every bracketed item has been resolved                |

### Beta App Review notes: build 80 (`production-carplay-google`)

The following build 80 template is a historical record from before the Canada cutover, not
the updated build 81 review notes. Complete applicable submission gates and update the notes for any
later submission.

```text
NavOSS is an account-free navigation app with search and routing in Alberta and British Columbia. No sign-in, purchase, subscription or demo credential is required.

To review search, tap Search, enter "Calgary Tower" or "Kelowna City Park", and select the result. From outside coverage, use "Preview a supported route" when current-location routing is unavailable. The preview shows route details without starting guidance. Physical GPS progress, rerouting and arrival require movement along a selected route.

The app requests When in Use precise location for map position and active navigation. After navigation starts, location updates continue while the phone is locked or another app is visible; they stop on End or confirmed arrival. NavOSS does not request Always location. Search and map browsing remain available when location is denied.

This build includes Google's Places UI Kit. Open a named place, business or landmark and expand its sheet to see Google's nearest listing, when available and within 30 metres, in a separate attributed panel. "Find this place on Google" opens Google's place search so a reviewer can select another listing. Street addresses and dropped pins do not request a Google panel. CarPlay shows no Google content. The Google SDK's privacy manifest declarations are included in App Privacy.

Share road reports is off by default. When enabled, an App Attest-verified installation can submit a structured road report; other drivers see it as unconfirmed until corroborated. Reports expire, are unofficial and do not change routes. Builds before 80 cannot share. Real iPhone registration through App Attest was not verified before the enablement decision.

Share traffic speeds is also off by default. With the driver's opt-in, eligible traffic batches are accepted, matched and counted in memory for evaluation. A newly registered installation must wait about one day before receiving a traffic upload credential. No community traffic is displayed or used in routes; there is no live traffic.

All Alberta and Calgary-area offline regions are available for download. British Columbia has no offline region. A physical iPhone download in build 80 remains unverified.

This build includes spoken guidance and CarPlay search, route preview and navigation. Interactive CarPlay has not been verified on a physical head unit. Fixed Calgary camera notices are informational and do not replace posted signs or laws. Map, search and routing data is OpenStreetMap-derived with attribution.

Production readiness: https://navoss-api.yassin.app/ready
Support: https://navoss.yassin.app/support
Privacy: https://navoss.yassin.app/privacy
```

The current app has no AI feature or AI provider. App Store Connect has no general “AI-authored code” disclosure field. Do not add an irrelevant AI statement to the review notes. If runtime behavior changes, reassess Guideline 5.1.2(i) before submission.

## App Privacy decision table

Production recipients and retention are now documented. Do not submit final answers until the account holder classifies direct OpenFreeMap requests and Cloudflare network/security processing. Apple defines collection as off-device transmission that lets the developer or a partner access data longer than needed to service the request in real time.

| Data type              | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                      | Final answer gate                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Precise Location       | Route/reroute coordinates transit Cloudflare to operator-hosted Valhalla and are discarded after each response. Active matching is on device. Direct map tile identifiers can describe the current view. A Google-enabled build sends a selected public POI name and coordinate directly to Google Places; Google's SDK manifest declares precise location for analytics and app functionality.                       | Route payloads meet Apple's Not Collected real-time exception. Classify OpenFreeMap/Cloudflare before upload. For an enabled build, disclose Google's manifest-declared precise-location collection and purposes.                      |
| Coarse Location        | Optional search origin is discarded after each response. IP addresses and requested map resources are processed by infrastructure providers. Google's enabled-build SDK manifest declares coarse location for analytics and app functionality.                                                                                                                                                                        | Search payloads meet the real-time exception. Decide whether provider-retained network/map metadata requires Location or Other Diagnostic Data. For an enabled build, include Google's declared collection and purposes.               |
| Search History         | Search text, or a tapped public place name and map coordinate, is sent in a JSON body to operator-hosted Nominatim and a local Calgary public-data index, then discarded after each response; the index stores source records, not queries, and tested values are absent from logs/backups. Google's enabled-build SDK manifest separately declares unlinked search history for analytics.                            | NavOSS search is Not Collected under Apple's real-time-service definition unless request tracing, persistence, or provider settings change. An enabled build must still disclose Google's SDK declaration.                             |
| Device ID              | The Google-disabled app creates no advertising ID, app user ID, or device-level identifier. Cloudflare/OpenFreeMap necessarily receive an IP address in transit. Google's enabled-build SDK manifest declares Device ID linked to identity for analytics and app functionality.                                                                                                                                       | Make the provider-level IP decision. For an enabled build, disclose Google's linked Device ID collection and purposes.                                                                                                                 |
| Customer Support       | Users may choose GitHub Issues, private vulnerability reporting, TestFlight feedback, or the planned support email.                                                                                                                                                                                                                                                                                                   | Reassess after the final in-app support path is fixed. Optional customer-support disclosure applies only when all of Apple's criteria are met.                                                                                         |
| Other User Content     | Contribute sends a user-entered description, optional place/road label, fixed report type, and timestamps to NavOSS. It is retained for up to 90 days live plus bounded backups, has no account/device identifier or precise coordinate, and is not public. NavOSS does not automatically send raw text to AI; operator policy permits only a separate human-created deidentified summary for engineering assistance. | Conservatively disclose as collected and linked to identity because free-form text may itself identify a person; not used for tracking; purpose App Functionality. Keep the app privacy manifest and App Store Connect answer aligned. |
| Other Data             | The Google-disabled build has no corresponding NavOSS collection. Google's enabled-build SDK manifest declares Other Data linked to identity for analytics.                                                                                                                                                                                                                                                           | No for the submitted Google-disabled build. Include Google's declaration for any enabled artifact.                                                                                                                                     |
| Product Interaction    | The Google-disabled build has no NavOSS analytics SDK. Google's enabled-build SDK manifest declares unlinked product interaction for analytics.                                                                                                                                                                                                                                                                       | No for the submitted Google-disabled build. Include Google's declaration for any enabled artifact.                                                                                                                                     |
| Crash/Performance Data | No NavOSS crash, analytics, APM, or uptime SDK is integrated. Host logs are bounded and exclude routine HTTP access events and payloads. Google's enabled-build SDK manifest declares unlinked performance data for analytics.                                                                                                                                                                                        | No app-originated collection in the Google-disabled build. Include Google's declaration for an enabled artifact and reassess before adding NavOSS telemetry.                                                                           |
| User ID                | No account or user ID exists.                                                                                                                                                                                                                                                                                                                                                                                         | No, unless a future service introduces an account-level or persistent identifier.                                                                                                                                                      |
| Purchases              | No commerce or StoreKit flow exists.                                                                                                                                                                                                                                                                                                                                                                                  | No.                                                                                                                                                                                                                                    |
| Contacts               | Not accessed. Place and ETA sharing use Apple's system share sheet; NavOSS does not receive Apple's suggested-recipient list.                                                                                                                                                                                                                                                                                         | No. Keep `NSContactsUsageDescription` absent unless this architecture changes.                                                                                                                                                         |
| Photos, Videos, Audio  | Not accessed or collected.                                                                                                                                                                                                                                                                                                                                                                                            | No.                                                                                                                                                                                                                                    |
| Tracking               | No ads, data broker, cross-app linking, or tracking SDK exists.                                                                                                                                                                                                                                                                                                                                                       | No, provided production providers do not repurpose data for tracking.                                                                                                                                                                  |

Any data type that is ultimately disclosed should use only its real purpose. For the Google-disabled build, the current expected provider purpose is App Functionality, not advertising, marketing, analytics, personalization, or tracking. An enabled artifact must also use the Analytics and App Functionality purposes exactly where Google's embedded manifest declares them; it still declares no tracking.

The conservative unresolved option is to disclose provider-retained map/network data as Location and/or Other Diagnostic Data for App Functionality, with no tracking. Whether it is linked depends on the account holder's final interpretation of temporary IP/security records and current provider terms.

The app-level privacy manifest conservatively declares linked Other User Content for App Functionality and no tracking because accepted free-form contribution text is retained server-side and may itself contain identifying details. A Google-enabled artifact embeds additional Google Places declarations and requires the additive Google data types, linkage, purposes, hosted policy, review notes, and archive inspection to match App Store Connect.

### Shared road reports and traffic sharing

Build 80 contains the native client and App Attest entitlement. Reports and traffic sharing are
off by default and require the driver's opt-in as well as server availability
(`features.communityReports` in `/v2/config`; `probes.accepting` in `/v2/traffic/status`).
Builds before 80 cannot share. App Privacy answers were published on 2026-11-15; keep App Store
Connect, the app privacy manifest, and the permission string aligned for each submitted artifact:

- **Precise Location.** A report sends the reporter's precise coordinate (and heading), which the
  server stores until 24 hours after the report expires; a "Still there?" answer sends a fresh
  coordinate that is used for a proximity check and discarded; traffic batches send short
  stretches of driven path. This is no longer covered by the real-time exception. Disclose
  Precise Location for App Functionality, not used for tracking. Conservatively mark it linked:
  reports are stored against a per-installation pseudonymous App Attest key that the server can
  relate to that installation's other reports and votes (traffic batches are not).
- **Device ID / other identifiers.** The App Attest key identifier is a per-installation
  identifier created by the app (stored hashed on the server, deletable with **Reset community
  identity**, replaced by reinstalling). Decide with the account holder whether Apple's Device ID
  category applies; the conservative answer is to disclose it as linked, for App Functionality
  (fraud prevention), not tracking.
- **Permission string.** The current string includes "except the place of a road report you
  choose to share." Verify the signed artifact retains that qualification.
- **Review notes.** Replace "no live traffic" only when traffic is actually live for reviewers,
  and describe reports as structured, expiring, unofficial, and never changing a route.

### App Privacy answers for community features

Published App Privacy answers cover community sharing and the Google panel. Reconcile the answers, app privacy manifest and permission string against the submitted artifact and current server behaviour:

| Data type / item                    | Needed answer                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Precise Location (reports, traffic) | Collected; App Functionality; not tracking; conservatively linked (per-installation App Attest key). No longer covered by the real-time exception.                                                                               |
| Device ID / other identifiers       | The App Attest key identifier: decide with the account holder; conservative answer is linked, App Functionality, not tracking.                                                                                                   |
| Permission string                   | The current string includes "except the place of a road report you choose to share"; confirm it in the signed artifact.                                                                                                          |
| Review notes                        | Describe reports as structured, expiring, unofficial and never changing a route; remove "no live traffic" only when traffic is live for reviewers.                                                                               |
| App Attest capability               | Capability on the App ID; EAS syncs it from the entitlement (`production` for every profile except `development`).                                                                                                               |
| Offline maps (#83, merged)          | The app privacy manifest must declare the required-reason "Disk space" API category (#83 added `NSPrivacyAccessedAPICategoryDiskSpace` to `app.json`; confirm it in the signed archive), and the policy must describe downloads. |

## Location and permissions

Current iOS purpose string:

> NavOSS uses your precise location to show your position and provide active turn-by-turn navigation, including while your phone is locked or connected to CarPlay. Location is not retained after navigation ends, except the place of a road report you choose to share.

Before upload, confirm the signed archive has:

- When in Use authorization with no Always location usage description;
- `UIBackgroundModes` containing only `location` for active navigation;
- no unrelated permission strings;
- no Contacts usage description or Contacts authorization request;
- permission requested only when the user invokes location-dependent functionality; and
- graceful denial/revocation behavior with search and map browsing still available.

## Age rating inputs

The legal owner must complete Apple's current questionnaire in App Store Connect. Use actual behavior, not a desired rating. Current factual inputs include:

- structured user-generated road reports appear to other drivers once report publication is enabled; re-answer the questionnaire and reassess Guideline 1.2;
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
- [x] Add a reviewer-accessible visible Calgary route preview before Beta App Review (shipped in build 16; re-verify after the phone UI refresh).
- [x] Freeze NavOSS-controlled data flows, providers, regions, logs, retention, backups, and deletion behavior.
- [x] Publish and verify the internal-beta privacy policy and support paths.
- [ ] Activate and test `navoss@yassin.app` from an external sender through a successful reply.
- [ ] Reconcile App Privacy answers, app/SDK privacy manifests, permission strings, and network captures.
- [ ] Complete age-rating, content-rights, and export-compliance questions.
- [ ] Enter reachable App Review contact details.
- [ ] Capture and validate production screenshots.
- [ ] Install the processed build from TestFlight without Metro and pass the clean-device smoke test.
