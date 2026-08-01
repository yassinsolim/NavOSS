# NavOSS privacy policy

Status: **ready for internal TestFlight**. A direct privacy/support email must be activated before external beta testing.

Effective date: July 31, 2026

NavOSS is an account-free navigation application beginning with a Calgary technical beta. This policy explains how NavOSS uses data when you view the map, inspect or search for a place, request a route, navigate, share a place or ETA, open an external link, or ask for support.

## Operator and contact

NavOSS is operated by Yassin Soliman as an individual developer in Alberta, Canada.

For a non-sensitive question, use the [public issue tracker](https://github.com/yassinsolim/NavOSS/issues). For a security issue or sensitive privacy request, use [GitHub's private vulnerability-reporting form](https://github.com/yassinsolim/NavOSS/security/advisories/new). Internal testers may also use TestFlight feedback, which is processed by Apple. Do not put an address, route, or other private information in a public issue.

The direct address `navoss@yassin.app` is not yet verified and is not presented as an active contact. External TestFlight and App Store submission remain blocked until direct delivery and reply handling are tested.

## Data used by the app

### Location during active navigation

When you grant When in Use location permission, NavOSS uses precise location to display your position, choose a route origin, match your position to an active route, detect rerouting and arrival, and determine whether an official safety camera is ahead in the direction of travel. If you start turn-by-turn navigation, location updates continue while the phone is locked, another app is visible, or CarPlay is connected. iOS displays its blue background-location indicator while this active session continues. NavOSS does not request Always location access.

Route requests send origin and destination coordinates to the NavOSS API. A reroute sends the latest route origin and destination. Current production uses Valhalla on the same operator-controlled server as the API. A future licensed live-traffic deployment may forward those route endpoints and preferences to Mapbox Directions; that mode remains disabled until its commercial vehicle-use license and release gates are complete. Active route matching and camera eligibility run on the phone. The current active route is stored transiently on the phone so navigation can recover after an operating-system restart, then erased when navigation ends or arrival is confirmed. Separately, the app stores up to 12 recent destinations and 20 places you save, including their names, labels, and coordinates, only on the device for phone and CarPlay shortcuts. It does not store route geometry or trip progress as destination history or send either list to NavOSS.

### Search text and place details

When you search, NavOSS sends the entered text and, when available, a search origin rounded to three decimal places, or roughly 100-meter granularity, to the NavOSS API in an encrypted request body. Search runs against self-hosted Alberta and British Columbia OpenStreetMap data. Calgary-origin searches can also use a local index of public City of Calgary business and parcel-address records on the same operator-controlled server; that civic index is not used for Kelowna searches. Search text and coordinates are not placed in public request URLs or written to the search index.

When you tap a named place rendered on the map, NavOSS sends that public place name and its map coordinate to the same API to find the nearest matching OpenStreetMap record. When OpenStreetMap has them, the response may include a public address, place category, opening-hours tag, business phone number, official website, and wheelchair-access tag. The request follows the same in-memory processing and discard rules as typed search. NavOSS does not obtain Google review content through this lookup.

In a build where Google Places details are explicitly enabled, opening a point-of-interest sheet also sends that selected public name and coordinate directly from the phone to Google Places. Google's Places UI Kit chooses the place and renders available photos, the star rating and rating count, review text, and required Google attribution inside its own visually separated component. NavOSS reads only the returned display name and coordinate to reject a mismatched place; it does not read the photo, rating, count, or review values, combine them with OpenStreetMap data, persist them, or send them to the NavOSS server. Builds without the restricted Google key do not make this request and show that Google photos, ratings, and reviews are unavailable.

Before an enabled phone opens Google's component, it asks the NavOSS API to reserve one anonymous monthly query grant. That request contains no place name, coordinate, account, device identifier, or search text. NavOSS stores only the UTC month, an aggregate used count, and its last update time. The server denies grants after 8,000 in a month, below Google's current 10,000-event no-charge allowance, and fails closed if the counter is unavailable.

An enabled build links GooglePlacesSwift 10.15.0 and its underlying Google Places SDK. The SDK's embedded Apple privacy manifest declares Google collection of precise and coarse location for analytics and app functionality; device ID linked to identity for analytics and app functionality; other data linked to identity for analytics; and unlinked performance data, product interaction, and search history for analytics. The manifest declares no tracking. These are Google-controlled SDK declarations beyond the rating values NavOSS requests or receives, and enabled-build App Privacy answers must include them.

### Map, road-event, and camera requests

The phone requests map styles, tiles, fonts, and sprites directly from the public OpenFreeMap service. OpenFreeMap therefore receives ordinary network information and the requested map resources, which can indicate the viewed map area. Its policy says regular logs are anonymized without IP addresses, while IP logging may be enabled during a security incident for no more than 30 days.

The phone obtains normalized safety-camera records from NavOSS. The NavOSS server refreshes the public City of Calgary Intersection Safety Cameras dataset every six hours and independently mirrors public business and parcel-address datasets every 24 hours. The phone and live search requests do not send location, search text, or route data to Calgary Open Data.

When road-event markers are enabled, the phone selects Calgary, Ontario, or Kelowna context locally
and requests only that region identifier from NavOSS; it does not send the coordinate in that
request. The NavOSS server polls public City of Calgary road events, Ontario 511, or DriveBC Open511
every five minutes. In Kelowna, the phone can also request DriveBC traffic-webcam metadata and fixed
public RCMP facilities using only the `kelowna-bc` region identifier. It does not forward phone
location, search text, routes, or user identifiers to those public-data services. DriveBC webcams
are not enforcement cameras, and RCMP facilities are not live police locations.

Map appearance choices, including style, navigation orientation, tilt, visible map content, safety-camera marker visibility, and route color, are stored only in the app on the device. These settings are not sent to NavOSS or used for analytics. Selecting a hosted map style changes which OpenFreeMap style resources the phone requests but does not add a new provider. Hiding camera markers does not disable active-navigation safety warnings.

### Sharing and external actions

Place sharing and Share ETA use the operating system's share sheet. The share text is created on the phone. A place share contains the public place name, its displayed address or category, and an OpenStreetMap link. An ETA share contains the chosen destination name, estimated arrival time, remaining time, and remaining distance. It does not contain the current coordinate, route geometry, a live-tracking link, or automatic updates.

NavOSS does not read the Contacts database and does not request Contacts permission. Apple may suggest recent recipients in the system share sheet, but NavOSS does not receive or store that list. Content is provided to Apple and to the app, service, and recipient the user chooses, under their respective policies.

Call and website actions open the phone dialer or an external browser/app only after the user chooses them. **More reviews on Google Maps** is a separate external action and sends the selected public place name and coordinate to Google only when chosen. NavOSS never scrapes or caches review text. In a Google-enabled build, the place-details request described above can occur when a point-of-interest sheet opens; the external reviews search still occurs only after the user chooses it.

The Contribute screen submits private beta feedback to NavOSS. A submission contains a fixed report type, user-entered description, optional place or road label, client creation time, and random draft and submission identifiers. It contains no account, device identifier, or precise coordinate. To limit abuse, the API keeps a salted, process-local fingerprint of the source network address for up to one hour; it is not logged or stored in PostgreSQL. Accepted submissions are visible only to the NavOSS beta-review workflow, are not public, and are scheduled for deletion from the live database after 90 days. Bounded database backups may retain a deleted row for up to 14 additional days. If submission fails, up to 25 pending attempts remain only on the device until retried, deleted, or the app is removed.

NavOSS does not automatically transmit raw feedback descriptions to an AI provider. Operator policy requires reviewing raw text outside an AI conversation. The operator may manually create a deidentified engineering summary after removing names, private addresses, contact details, exact personal trips, credentials, and unnecessary timestamps. The summary is stored in an ignored local workspace artifact. Only when the operator explicitly invokes AI-assisted triage is that deidentified summary transmitted to the configured coding-assistant provider under its terms, to group reports, draft issues, or help implement a human-approved item. The summary contains no account or contributor identifier.

During active navigation, the report button can store up to 25 structured road-report test drafts on the device. Each draft contains one of four fixed report types, the current precise coordinate, its creation time, and a two-hour expiry time. It contains no free text, photo, account, or public user name. These test drafts are not sent to NavOSS or a third party and are not shown to other drivers. Expired drafts are discarded when the local list is next read or written, and removing the app removes all remaining drafts.

### Service and security data

The default Google-disabled build has no account, advertising, analytics, crash-reporting, data-broker, cross-app tracking, or runtime AI service. It does not use an advertising identifier or create a persistent user or device identifier. A separately enabled Google place-details build links the Google Places SDK and is subject to the SDK declarations described above; NavOSS does not receive or operate that Google analytics data.

Cloudflare provides public DNS, TLS termination, denial-of-service protection, and an outbound tunnel to the NavOSS server. Cloudflare necessarily processes the client IP address, request traffic, and routing/security metadata. NavOSS does not enable Cloudflare raw request-log export or store Cloudflare per-request access logs. Cloudflare may create and retain network or security data under its own privacy policy.

## Purposes

NavOSS uses data only to provide map rendering, road-event awareness, place details, search, routing, navigation, rerouting, arrival detection, safety-camera notices, user-requested sharing and external actions, service reliability, abuse prevention, security, and user-requested support.

NavOSS does not sell personal information or use it for advertising, marketing profiles, or cross-app tracking.

## Providers and processing locations

| Provider                                                                                           | Purpose and data                                                                                                                                                                                                                             | Location or policy                                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| NavOSS operator-controlled server                                                                  | API, Nominatim and indexed Calgary search, Valhalla routing, camera normalization, and operational security                                                                                                                                  | Alberta, Canada                                                                     |
| [Cloudflare](https://www.cloudflare.com/privacypolicy/)                                            | DNS, TLS, traffic delivery, tunnel, and network security; processes IP and request traffic                                                                                                                                                   | Global network; Cloudflare describes international transfers in its policy          |
| [OpenFreeMap](https://openfreemap.org/privacy/)                                                    | Direct map style, tile, font, and sprite delivery                                                                                                                                                                                            | Hyperknot Software Kft. in Hungary, with infrastructure that may include Cloudflare |
| [Ontario 511](https://511on.ca/developers/doc)                                                     | Official construction, closure, and incident data polled by the NavOSS server; receives no phone location or user data                                                                                                                       | Government of Ontario                                                               |
| [DriveBC](https://www.drivebc.ca/)                                                                 | Official Kelowna-area Open511 road events and ordinary highway-webcam metadata polled by NavOSS; receives no phone location or user data                                                                                                     | Government of British Columbia                                                      |
| [Kelowna RCMP](https://rcmp.ca/en/bc/kelowna/contact)                                              | Published fixed public facility names, addresses, phones, and coordinates; no live police data                                                                                                                                               | Royal Canadian Mounted Police                                                       |
| [Mapbox](https://www.mapbox.com/legal/privacy/)                                                    | Optional licensed live-traffic routing; receives route endpoints, preferences, and request network metadata only when explicitly enabled                                                                                                     | Global infrastructure; disabled in current production                               |
| [Apple](https://www.apple.com/legal/privacy/)                                                      | TestFlight distribution, tester feedback, and the user-invoked system share sheet                                                                                                                                                            | Under Apple's policy                                                                |
| [Google Places and Google Maps](https://policies.google.com/privacy)                               | Optional photos, rating/count, and reviews in an enabled build; Google SDK manifest declares location, device ID, other data, performance, interaction, and search-history collection; external review search only after the user chooses it | Under Google's policy                                                               |
| [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) | Public issues and private vulnerability reports initiated by a user                                                                                                                                                                          | Under GitHub's policy                                                               |

Map and route data is derived from OpenStreetMap contributors. Search combines OpenStreetMap with the City of Calgary's public Business Licenses and Parcel Address datasets. Enforcement-camera records come from public Calgary and Toronto datasets. Road events come from public City of Calgary data, Ontario 511, and DriveBC. Kelowna traffic webcams come from the DriveBC HighwayCams catalogue, and fixed police-facility markers come from the RCMP contact directory. Public Photon and FOSSGIS services are not used by the production API.

## Retention

| Data                                               | NavOSS retention                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search text, tapped-place name, and search origin  | Processed in memory for the response, then discarded; not written to a NavOSS database, access log, or backup                                                                                                                        |
| Route and reroute coordinates                      | Processed in memory for the response, then discarded; not written to a NavOSS database, access log, or backup                                                                                                                        |
| Active route, trip progress and camera eligibility | Processed on the phone; the active route is erased when navigation ends or arrival is confirmed; no trip-history database                                                                                                            |
| Recent and saved destinations                      | Up to 12 recent and 20 saved destination names, labels, and coordinates stored only on the device until cleared in About and Privacy or the app is removed                                                                           |
| Map appearance preferences                         | Stored locally in app storage until the app is removed or the settings are changed; not transmitted to NavOSS                                                                                                                        |
| Accepted beta contributions                        | Type, description, optional place/road label, timestamps, random draft/submission IDs, and review status retained in the live database for up to 90 days; no account, device ID, or precise coordinate                               |
| Pending contribution retries                       | Up to 25 failed submissions stored only on the device until successfully retried, individually deleted, or the app is removed                                                                                                        |
| Road-report test drafts                            | Up to 25 structured report types, precise coordinates, creation times, and expiry times stored only on the device; each expires after two hours and all are removed with the app                                                     |
| Google-enabled place component                     | Selected public POI name and coordinate sent directly to Google; response not retained by NavOSS. Google's embedded manifest separately declares the SDK data categories and purposes listed above under Google's retention controls |
| Google query safety counter                        | UTC month, aggregate used count, and last update time retained in the NavOSS database; contains no place, coordinate, account, device, or search data                                                                                |
| Place and ETA share text                           | Created on the phone and not sent to NavOSS; controlled by Apple and the user-selected share destination                                                                                                                             |
| Public Calgary business and parcel search index    | Current local mirror refreshed every 24 hours; reproducible index tables are excluded from logical backups                                                                                                                           |
| API and service operational logs                   | Maximum seven days; routine HTTP access logging is disabled                                                                                                                                                                          |
| Host authentication and firewall security logs     | Maximum seven days; may contain timestamp, source IP and port, local account, action, and outcome                                                                                                                                    |
| Report database backups                            | Maximum 14 days; may contain accepted beta contributions but do not contain route or search requests                                                                                                                                 |
| Support messages                                   | Controlled by Apple or GitHub according to the channel selected by the user and that provider's policy                                                                                                                               |

NavOSS operational logs are limited to timestamps, service/container identity, severity, lifecycle events, health failures, error names, and random request IDs where needed. They exclude HTTP request and response bodies, search text, route coordinates, and normal HTTP access events. All six production containers write to the host journal, which enforces a seven-day and 512 MiB limit. Caddy access logs and automatic Fastify request logs are disabled.

Cloudflare and OpenFreeMap apply their own retention policies to data they process. Cloudflare's policy does not promise one fixed period for all end-user network/security data. OpenFreeMap states that anonymized logs may be retained indefinitely and incident IP logs for at most 30 days. These provider-controlled periods are not part of NavOSS's seven-day host limit.

## Choices and deletion

You can deny or revoke location in iOS Settings. Search and map browsing remain available, but current-position routing and active navigation will be limited. You can stop an active trip using End navigation, which stops background location and erases the transient active route.

You can erase all locally stored recent and saved destinations at any time using **Clear saved and recent destinations** in the app's About and Privacy screen. Pending contribution retries can be deleted individually on the Contribute screen. Accepted beta feedback cannot be linked back to an account because NavOSS has no account or contributor identifier; contact support with the random submission ID if deletion before automatic expiry is required. Road-report test drafts expire after two hours. Removing the app removes all remaining local records.

You can use NavOSS without granting Contacts access because the app never asks for it. Sharing and the external reviews link are optional, user-initiated actions. Dismissing the system share sheet sends nothing to a recipient. In a Google-enabled build, opening a POI sheet can send its public coordinate for Google-rendered photos, ratings, and reviews; choosing no external reviews link sends no Google Maps search.

Because NavOSS has no account and does not retain server-side search, route, or trip records, it normally has no server history that can be exported or deleted. The local recent- and saved-destination lists can be deleted in the app as described above. A rights request may identify a support message or a recent security event. Include only enough information to locate that record. NavOSS may be unable to associate an IP-only, transient request with a person. Requests about Cloudflare, OpenFreeMap, Apple, or GitHub data may also need to be directed to that provider.

## Children

NavOSS is a general-audience navigation utility and is not directed to children. It does not create profiles or knowingly maintain children's personal information. A parent or guardian should supervise a minor's use of navigation and support channels.

## Security and international processing

App-to-API traffic uses HTTPS through Cloudflare. The origin is reachable through an outbound tunnel rather than a public inbound port. The host uses key-only SSH, a default-deny firewall, encrypted transport, least-privilege containers, read-only filesystems where practical, security updates, bounded logs, and encrypted provider connections where applicable.

The NavOSS origin is in Alberta, but Cloudflare, OpenFreeMap, Apple, Google when place details are enabled or the external reviews link is chosen, GitHub, and a user-selected share destination may process data outside Canada as described in their policies. No security measure can guarantee absolute protection.

## Changes

Material changes will be posted at this URL with a revised effective date. During beta testing, material data-use changes will also be called out in TestFlight release notes before the changed feature is tested.
