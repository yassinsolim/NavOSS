# App Store Connect metadata draft

Status: incomplete release draft. Replace every `REQUIRED` value before upload.

## App information

| Field              | Draft                                              |
| ------------------ | -------------------------------------------------- |
| Name               | NavOSS                                             |
| Bundle ID          | `org.navoss.mobile`                                |
| Version            | `0.1.0`                                            |
| Primary language   | English (Canada)                                   |
| Primary category   | Navigation                                         |
| Secondary category | Travel                                             |
| Subtitle           | Private Calgary navigation                         |
| SKU                | `navoss-ios-001`                                   |
| Privacy policy URL | `https://navoss.yassin.app/privacy` (must be live) |
| Support URL        | `https://navoss.yassin.app/support` (must be live) |
| Marketing URL      | `https://navoss.yassin.app` (after launch)         |
| Copyright          | `2026 Yassin Soliman`                              |

Suggested keywords, under Apple's 100-character limit:

```text
navigation,Calgary,maps,routing,privacy,GPS,safety cameras,directions
```

## TestFlight beta description

NavOSS is an account-free, privacy-first Calgary navigation technical beta. It provides Calgary place search, route alternatives, avoid-highways routing, foreground GPS progress, automatic rerouting, arrival detection, and official City of Calgary safety-camera markers and route-ahead alerts.

This build has no live traffic and does not yet provide background or spoken turn-by-turn guidance. Keep the app visible during a test trip and have a passenger operate the phone. Do not rely on the beta as the only navigation or safety source.

## What to Test

1. Search for a Calgary landmark, business, or address and report missing or incorrect results.
2. Compare the suggested route, distance, ETA, first maneuver, and major roads with current road conditions.
3. Toggle Avoid highways and confirm the route changes meaningfully.
4. Start guidance with the phone mounted and a passenger operating it; report puck jumps, incorrect maneuvers, false reroutes, missed reroutes, or early/late arrival.
5. On a lawful trip past an official camera, report missing, repeated, late, or wrong-direction alerts.
6. End navigation and confirm location activity stops.

Include the start area, destination, local time, and unexpected road or maneuver. Avoid including a private address unless necessary to reproduce the issue.

## App Review notes

- No account, sign-in, subscription, purchase, or demo credentials are required.
- Coverage is intentionally limited to Calgary, Alberta.
- Foreground precise location is used for map position, route matching, rerouting, arrival, and route-ahead camera warnings.
- Search text and route endpoints are sent to the configured NavOSS services. Automatic request logging is disabled.
- The app does not request background location in this beta.
- Live traffic is explicitly unavailable.
- Safety-camera records come from the City of Calgary Intersection Safety Cameras open dataset and may change monthly.
- Map/search/routing data is OpenStreetMap-derived with visible attribution.
- Review contact name, phone, and email: REQUIRED.
- Production API will remain available throughout review: REQUIRED URL and monitoring owner.

Provide reviewers a reproducible Calgary route, such as Downtown Calgary to Calgary International Airport, and explain that camera speech is exercised only when approaching a matching official camera in the route direction.

## App Privacy draft

Use this as a conservative starting point, then reconcile it with the final production providers and retention policy in App Store Connect.

| Data type        | Collected | Linked to identity | Tracking | Purpose                                                    |
| ---------------- | --------- | ------------------ | -------- | ---------------------------------------------------------- |
| Precise Location | Yes       | No                 | No       | App Functionality: route origin, rerouting, and navigation |
| Search History   | Yes       | No                 | No       | App Functionality: place/address search                    |
| User ID          | No        | N/A                | No       | No account system                                          |
| Device ID        | No        | N/A                | No       | No advertising or analytics identifier                     |
| Purchases        | No        | N/A                | No       | No commerce                                                |
| Contacts         | No        | N/A                | No       | Not accessed                                               |
| Photos/Audio     | No        | N/A                | No       | Not accessed                                               |

The final answer depends on Apple's definition of collection and the actual backend/provider retention. If route/search data is used only transiently to fulfill the request and is not retained, App Store Connect may classify it differently. Do not choose the less-disclosive answer without confirming production logs, subprocessors, and Apple's current definitions.

## Screenshots

Capture real production-build screens at the current iPhone sizes requested by App Store Connect:

- Calgary map with search and healthy production service status;
- useful search results;
- route alternatives with ETA/distance and Avoid highways;
- active foreground guidance with a maneuver;
- official safety-camera markers/alert; and
- arrival state.

Do not show simulator-only labels, reserved endpoints, personal addresses, debug UI, or claims of traffic/Apple/Google parity.

## Remaining fields

- REQUIRED: activate and test `navoss@yassin.app` forwarding.
- REQUIRED: publish and verify the privacy and support URLs above.
- REQUIRED: age-rating questionnaire completed by the legal owner.
- REQUIRED: final encryption/export-compliance determination.
- REQUIRED: final App Privacy answers after backend deployment.
- REQUIRED: make `PrivacyInfo.xcprivacy` collection entries match those final answers and retention practices.
- REQUIRED: publish the source repository before adding an open-source App Store claim.
- REQUIRED: production screenshots and review contact.
