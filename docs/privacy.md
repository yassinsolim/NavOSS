# NavOSS privacy policy

Status: **ready for internal TestFlight**. A direct privacy/support email must be activated before external beta testing.

Effective date: November 12, 2026

NavOSS is an account-free navigation application beginning with a Calgary technical beta. This policy explains how NavOSS uses data when you view the map, inspect or search for a place, request a route, navigate, share a place or ETA, open an external link, or ask for support.

## Operator and contact

NavOSS is operated by Yassin Soliman as an individual developer in Alberta, Canada.

For a non-sensitive question, use the [public issue tracker](https://github.com/yassinsolim/NavOSS/issues). For a security issue or sensitive privacy request, use [GitHub's private vulnerability-reporting form](https://github.com/yassinsolim/NavOSS/security/advisories/new). Internal testers may also use TestFlight feedback, which is processed by Apple. Do not put an address, route, or other private information in a public issue.

The direct address `navoss@yassin.app` is not yet verified and is not presented as an active contact. External TestFlight and App Store submission remain blocked until direct delivery and reply handling are tested.

## Data used by the app

### Location during active navigation

When you grant When in Use location permission, NavOSS uses precise location to display your position, choose a route origin, match your position to an active route, detect rerouting and arrival, and determine whether an official safety camera is ahead in the direction of travel. If you start turn-by-turn navigation, location updates continue while the phone is locked, another app is visible, or CarPlay is connected. iOS displays its blue background-location indicator while this active session continues. NavOSS does not request Always location access. If you switch on traffic sharing, positions along through roads are also sent during navigation as described under [Traffic sharing](#traffic-sharing-optional-off-by-default); it is off unless you turn it on.

Route requests send origin and destination coordinates to the NavOSS API. A reroute sends the latest route origin and destination. Current production uses Valhalla on the same operator-controlled server as the API. A future licensed live-traffic deployment may forward those route endpoints and preferences to Mapbox Directions; that mode remains disabled until its commercial vehicle-use license and release gates are complete. Active route matching and camera eligibility run on the phone. The current active route is stored transiently on the phone so navigation can recover after an operating-system restart, then erased when navigation ends or arrival is confirmed. Separately, the app stores up to 12 recent destinations and 20 places you save, including their names, labels, and coordinates, only on the device for phone and CarPlay shortcuts. It does not store route geometry or trip progress as destination history or send either list to NavOSS.

### Traffic sharing (optional, off by default)

NavOSS can build live traffic from the driving speeds of people who choose to share them. Traffic
sharing is **off by default**. The NavOSS server supports it, but it is not switched on in
production and no released version of the app sends driving observations yet. The paragraphs
below describe what the server does. Statements about what the app does are requirements for the
app version that adds the **Share traffic speeds** switch; no released app has been checked
against them yet.

**What is sent.** While sharing is on and turn-by-turn navigation is active, the app sends short
batches of your driving positions to the NavOSS API. A batch is a list of positions, each with the
number of seconds since the batch's first position, plus the time the batch started rounded down
to the minute, plus an upload credential (described below). A batch covers about one minute of
driving and never more than five. It contains no account, no name, no advertising identifier, no
trip or sequence identifier, no destination and no planned route. It does contain a short stretch
of the path you actually drove. Batches from one trip carry the same upload credential, come from
the same network address, and continue where the previous one stopped, so the server and
Cloudflare could link them while they are being delivered. NavOSS does not record that link.

**Upload credentials and abuse resistance.** To make made-up traffic harder, the server accepts
batches only with an upload credential, and issues one only to an installation of the app that
has registered an Apple App Attest key for NavOSS and signs a fresh request with it. For that key
the server stores a keyed hash of the key's identifier, the public key in encrypted form, a
counter, whether Apple attested it, and the times it was registered and last used. A periodic
cleanup deletes a key after 90 days without use; it is best effort, so a key can remain somewhat
longer if a cleanup run fails. A key registered less than a day earlier gets no credential yet.
The credential is valid for two hours. The server keeps no record of which installation a
credential was issued to, and nothing it stores about traffic refers to an installation or a
credential, but asking for a credential does update the key's counter and "last used" time.

App Attest shows that a request was signed by a genuine copy of the app on an Apple device. It
does not show that the device was driving, and one iPhone can register several keys. A
credential is a bearer token: whoever holds it can upload with it until it expires, from any
device. A test setting makes the server accept software keys instead; the committed production
configuration leaves it off, and the enablement checklist requires that.

**When it is sent.** Only during active turn-by-turn navigation, including while the phone is
locked or CarPlay is connected, about once a minute. Nothing is sent while you browse the map,
search, preview a route, or drive without navigation, and nothing is sent when sharing is off.
The server refuses a batch whose first position is more than 10 minutes old when it arrives.

**What is left out.** The app is required not to record the first 400 metres or the last 400
metres of a trip, or anything within 400 metres of your destination or a stop on the way, and to
hold back the most recent 400 metres so that a trip you end early never sends its final stretch.
The server cannot check this, because it is never told where a trip starts or ends. What the
server itself does is discard the first and last 100 metres of every batch it receives and use
only motorways, trunk roads, primary roads and secondary roads. Of those, it uses only stretches
at least 20 metres long that the routing software's map marks as open to cars and as neither
private or destination-only access nor a dead end or the road into or out of an area with no
other exit. That map check reaches only as far as the routing software looks: a large area with
a single exit, such as a valley with its own road network, can still be used. Positions on other
roads (tertiary and residential streets, service roads, driveways, tracks, and parking areas)
may still be uploaded and matched to the map in memory, but nothing is kept from them.

**What the server does.** The server matches a batch to roads in memory, works out one average
speed for each continuous run along one road in one direction, and gives that speed to each
qualifying stretch between two junctions that the batch passed through from end to end according
to the map matching. It holds those speeds in memory and discards the batch. The NavOSS API does
not write your positions, the batch, or its timing to its database, a backup, or its log. To
match a batch to roads and check the map the API uses routing software (Valhalla) that it
requires to be at a local network address; on the production stack that is a container on the
same NavOSS-controlled machine in Alberta. The address check by itself does not prove where the
software runs or who operates it, and NavOSS will confirm the production deployment before
switching publication on. Batches are not forwarded to another routing provider. The map check
sends the routing software only points on the map's own roads, never your positions. Like every
request to NavOSS, a batch is delivered through Cloudflare, which sees it in transit. NavOSS has
not yet verified that the routing software, the reverse proxy's error handling, system swap, or
crash dumps on the production machine never write any part of a batch, and will not switch
publication on until it has.

**What is kept, and for how long.**

- _Before publication, in memory only._ For each stretch of road, the server's memory holds one
  speed per contributor, the five-minute period in which it arrived, when the batch's driving
  began, and a scrambled marker that tells contributors apart. The marker is derived from your
  App Attest installation and that one stretch of road using a secret that exists only in the
  running server's memory. Markers for two different roads are unrelated, so they cannot be
  matched to each other by comparing them; your marker for one stretch stays the same across
  five-minute periods and credentials until the server restarts. For an installation registered
  in the last seven days, the memory also holds a scrambled marker of the network the batch came
  from, so that several new keys on one network count once. This is dropped after at most 20
  minutes and is lost whenever the server restarts. It is never written to the database.
- _After publication, in the database._ Once at least three installations have driven the same
  stretch, the server stores one typical speed for it, rounded to 5 km/h, the public
  OpenStreetMap shape of that stretch, and the five-minute boundary at which it was published. It
  is never shown after 15 minutes. It is deleted at that point by the server's next successful
  database update, which is normally at that moment and otherwise at a later five-minute
  boundary; it is erased whenever the server starts (including when the feature is switched off,
  in which case the server retries until the erasure succeeds); and it is excluded from database
  backups. Nothing deletes it while the server is stopped.
- _Abuse limits, in memory only._ The server keeps salted fingerprints of the source network and
  of the contributor, with request times, for up to 11 minutes after the last request.
- _Operator counters._ Every 15 minutes the server logs running totals (batches, credentials,
  stretches published, failures). They contain no road, position, address or installation and
  are kept as long as other operational logs.

Everything derived from a batch leaves memory within 20 minutes of its arrival and is no longer
shown within 35 minutes; physical deletion from the database can be later, as described above.
These periods, the minimum of three contributors, and the road rules are fixed in the server's
code and cannot be weakened by configuration.

**What other drivers see.** A stretch of road is coloured, and can affect an estimated arrival
time, only after at least three different App Attest installations have driven that same stretch,
each in a batch whose driving began within the 15 minutes before a five-minute boundary, and only
from that boundary. It stays shown for at most 15 minutes, so what other drivers see rests on
driving at most 30 minutes old. Three installations are three keys, not necessarily three
people. A stretch driven by one or two contributors is never shown and never stored. Other drivers
see, for each published stretch, its shape, a congestion colour, a typical speed rounded to
5 km/h, the road's normal speed, and the five-minute boundary at which it was published. They
never see a vehicle, a trip, a count of contributors, or who contributed. With few contributors,
most roads will show no traffic at all.

**What NavOSS cannot rule out.** This is data minimisation with a threshold, not anonymity.

- Three installations are not necessarily three unrelated people. They can be one household, or
  one person who has registered several keys and kept them for a week or used several networks.
- On a quiet road, the fact that a stretch was driven by at least three contributors shortly
  before a given five-minute boundary becomes visible to anyone watching the map, and the small
  group who drive there may be guessable.
- If two of the three contributors on a stretch cooperate, they can infer that a third person
  drove it in that window, roughly how fast, and at a junction which way they went.
- Someone with access to the running server's memory, together with its database, could work out
  which installation contributed to a stretch that is still waiting for publication.
- Cloudflare and the NavOSS server necessarily see each upload and its network address while it
  is being delivered, as they do for every request.
- A home on a secondary or larger through road is on a road the server uses. Only the trimming
  the app performs and the three-contributor rule protect it.

**How to turn it off.** Turn off **Share traffic speeds** in the app's About and Privacy screen.
Uploads are required to stop immediately and anything not yet sent to be discarded. Ending
navigation or removing the app has the same effect. What was contributed stops being shown
within 35 minutes and is deleted as described above. Nothing about traffic is stored with an
account, an installation, or a trip identifier, so there is no per-person traffic record to look
up or delete. You can see traffic from other drivers without sharing your own.

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

The Contribute screen submits private beta feedback to NavOSS. A submission contains a fixed report type, user-entered description, optional place or road label, client creation time, and random draft and submission identifiers. It contains no account, device identifier, or precise coordinate. To limit abuse, the API keeps a salted, process-local fingerprint of the source network address for up to one hour after the last submission, plus up to one minute until the next cleanup; it is not logged or stored in PostgreSQL. Accepted submissions are visible only to the NavOSS beta-review workflow, are not public, and are scheduled for deletion from the live database after 90 days. Bounded database backups may retain a deleted row for up to 14 additional days. If submission fails, up to 25 pending attempts remain only on the device until retried, deleted, or the app is removed.

NavOSS does not automatically transmit raw feedback descriptions to an AI provider. Operator policy requires reviewing raw text outside an AI conversation. The operator may manually create a deidentified engineering summary after removing names, private addresses, contact details, exact personal trips, credentials, and unnecessary timestamps. The summary is stored in an ignored local workspace artifact. Only when the operator explicitly invokes AI-assisted triage is that deidentified summary transmitted to the configured coding-assistant provider under its terms, to group reports, draft issues, or help implement a human-approved item. The summary contains no account or contributor identifier.

### Community road reports

NavOSS can share structured road reports between drivers. The NavOSS server decides whether
sharing is on (`features.communityReports`); it is off until the operator enables it. While it
is off, or on a device that cannot use Apple App Attest, the app keeps the private drafts
described at the end of this section and sends nothing.

**What a report sends.** When sharing is on and you choose a report type, the app sends one of
eight fixed types (crash, road closed, slow traffic, construction, pothole, object on road, other
hazard, stopped vehicle), your current precise coordinate, your direction of travel in whole
degrees when known, and an App Attest signature with its key identifier. It contains no free
text, photo, name, account, destination, or route. The server stores the precise coordinate and
a copy snapped to a grid of about 55 m by 35 m. Other drivers receive only the snapped position,
the type, the report and expiry times rounded to five minutes, and a confirmation count; never
who reported it. A report expires after two hours; confirmations can extend it to at most 12
hours after it was made, and "not there" answers shorten or end it. No report changes a route.

**Reading reports.** The app asks the server for reports in the area you are viewing or, during
guidance, in a box around the route ahead (at most half a degree each way). These requests carry
no identity, and the app keeps the answers in memory only. The CarPlay map shows the same reports.
During guidance the app can show, and if **Spoken road reports** is on and the guidance sound
allows alerts, speak a short alert for a report ahead.

**Still there?** After you pass a report, and never near a turn, the app may ask whether it is
still there. **Still there** or **Not there** sends that answer with your current coordinate,
which the server uses only to check that you are within 1.5 km of the report and then discards.
Letting the question disappear sends nothing. The app does not ask about reports you made during the same app session.

**Identity and deletion.** The first report registers an App Attest key for this installation.
The phone stores only the key's identifier, in the iOS Keychain on this device; the key itself
stays in the iPhone's Secure Enclave. The server stores the key as described under
[Traffic sharing](#traffic-sharing-optional-off-by-default), plus, for 24 hours, the position of
the installation's latest report or answer rounded to about 1 km, to reject impossible travel.
You can withdraw a report you made in the same app session. **Reset community identity**
deletes the installation from the server with all its reports and answers, and forgets the key on
the phone; a later report registers a new key that is not linked to the old one. Development
builds running in the iOS Simulator can use a software key that only a test server accepts;
release builds cannot.

**Private drafts.** When sharing is off or unavailable, the report button stores up to 25
structured road-report drafts on the device. Each draft contains one of the eight fixed report
types, the current precise coordinate, its creation time, and a two-hour expiry time. It contains
no free text, photo, account, or public user name. Drafts are not sent to NavOSS or a third party
and are not shown to other drivers. Expired drafts are discarded when the local list is next read
or written, and removing the app removes all remaining drafts.

### Service and security data

The default Google-disabled build has no account, advertising, analytics, crash-reporting, data-broker, cross-app tracking, or runtime AI service. It does not use an advertising identifier or create a persistent user or device identifier, except that a phone which turns on traffic sharing or community reports registers an App Attest key, described under [Traffic sharing](#traffic-sharing-optional-off-by-default) and [Community road reports](#community-road-reports), which the server keeps until 90 days after its last use. A separately enabled Google place-details build links the Google Places SDK and is subject to the SDK declarations described above; NavOSS does not receive or operate that Google analytics data.

Cloudflare provides public DNS, TLS termination, denial-of-service protection, and an outbound tunnel to the NavOSS server. Cloudflare necessarily processes the client IP address, request traffic, and routing/security metadata. NavOSS does not enable Cloudflare raw request-log export or store Cloudflare per-request access logs. Cloudflare may create and retain network or security data under its own privacy policy.

## Purposes

NavOSS uses data only to provide map rendering, road-event awareness, place details, search, routing, navigation, rerouting, arrival detection, safety-camera notices, community road reports, community traffic for and from drivers who opt in, user-requested sharing and external actions, service reliability, abuse prevention, security, and user-requested support.

NavOSS does not sell personal information or use it for advertising, marketing profiles, or cross-app tracking.

## Providers and processing locations

| Provider                                                                                           | Purpose and data                                                                                                                                                                                                                             | Location or policy                                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| NavOSS operator-controlled server                                                                  | API, Nominatim and indexed Calgary search, Valhalla routing and road matching of opted-in traffic batches, camera normalization, and operational security                                                                                    | Alberta, Canada                                                                     |
| [Cloudflare](https://www.cloudflare.com/privacypolicy/)                                            | DNS, TLS, traffic delivery, tunnel, and network security; processes IP and request traffic                                                                                                                                                   | Global network; Cloudflare describes international transfers in its policy          |
| [OpenFreeMap](https://openfreemap.org/privacy/)                                                    | Direct map style, tile, font, and sprite delivery                                                                                                                                                                                            | Hyperknot Software Kft. in Hungary, with infrastructure that may include Cloudflare |
| [Ontario 511](https://511on.ca/developers/doc)                                                     | Official construction, closure, and incident data polled by the NavOSS server; receives no phone location or user data                                                                                                                       | Government of Ontario                                                               |
| [DriveBC](https://www.drivebc.ca/)                                                                 | Official Kelowna-area Open511 road events and ordinary highway-webcam metadata polled by NavOSS; receives no phone location or user data                                                                                                     | Government of British Columbia                                                      |
| [Kelowna RCMP](https://rcmp.ca/en/bc/kelowna/contact)                                              | Published fixed public facility names, addresses, phones, and coordinates; no live police data                                                                                                                                               | Royal Canadian Mounted Police                                                       |
| [Mapbox](https://www.mapbox.com/legal/privacy/)                                                    | Optional licensed live-traffic routing; receives route endpoints, preferences, and request network metadata only when explicitly enabled                                                                                                     | Global infrastructure; disabled in current production                               |
| [Apple](https://www.apple.com/legal/privacy/)                                                      | TestFlight distribution, tester feedback, the user-invoked system share sheet, and App Attest, which the phone uses to create the key that signs community road reports and obtains traffic-upload credentials                               | Under Apple's policy                                                                |
| [Google Places and Google Maps](https://policies.google.com/privacy)                               | Optional photos, rating/count, and reviews in an enabled build; Google SDK manifest declares location, device ID, other data, performance, interaction, and search-history collection; external review search only after the user chooses it | Under Google's policy                                                               |
| [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) | Public issues and private vulnerability reports initiated by a user                                                                                                                                                                          | Under GitHub's policy                                                               |

Map and route data is derived from OpenStreetMap contributors. Search combines OpenStreetMap with the City of Calgary's public Business Licenses and Parcel Address datasets. Enforcement-camera records come from public Calgary and Toronto datasets. Road events come from public City of Calgary data, Ontario 511, and DriveBC. Kelowna traffic webcams come from the DriveBC HighwayCams catalogue, and fixed police-facility markers come from the RCMP contact directory. Public Photon and FOSSGIS services are not used by the production API.

## Retention

| Data                                               | NavOSS retention                                                                                                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search text, tapped-place name, and search origin  | Processed in memory for the response, then discarded; not written to a NavOSS database, access log, or backup                                                                                                                            |
| Route and reroute coordinates                      | Processed in memory for the response, then discarded; not written to a NavOSS database, access log, or backup                                                                                                                            |
| Traffic-sharing batches (only when switched on)    | Positions and timing processed in memory and discarded; not written by the NavOSS API to its database, log, or a backup                                                                                                                  |
| Unpublished traffic speeds                         | API memory only: one speed per contributor and road stretch with a per-road scrambled marker (and, for keys registered in the last seven days, a scrambled network marker); dropped within 20 minutes; never in the database             |
| Published traffic speeds                           | Per road stretch: speed rounded to 5 km/h, public road shape, five-minute publication time; never shown after 15 minutes; deleted by the next successful database update after that, erased on every server start, excluded from backups |
| App Attest key for traffic sharing                 | Keyed hash of the key identifier, encrypted public key, counter, registration and last-use times; removed by a periodic best-effort cleanup after 90 days without use                                                                    |
| Active route, trip progress and camera eligibility | Processed on the phone; the active route is erased when navigation ends or arrival is confirmed; no trip-history database                                                                                                                |
| Recent and saved destinations                      | Up to 12 recent and 20 saved destination names, labels, and coordinates stored only on the device until cleared in About and Privacy or the app is removed                                                                               |
| Map appearance preferences                         | Stored locally in app storage until the app is removed or the settings are changed; not transmitted to NavOSS                                                                                                                            |
| Accepted beta contributions                        | Type, description, optional place/road label, timestamps, random draft/submission IDs, and review status retained in the live database for up to 90 days; no account, device ID, or precise coordinate                                   |
| Pending contribution retries                       | Up to 25 failed submissions stored only on the device until successfully retried, individually deleted, or the app is removed                                                                                                            |
| Community road reports                             | Type, precise and grid-snapped coordinates, heading, times, and the reporting installation; deleted 24 hours after expiry (immediately expired when withdrawn), at once with Reset community identity; excluded from backups             |
| "Still there?" answers                             | Answer, time, and the answering installation; deleted with the report; the answer coordinate is discarded after the proximity check                                                                                                      |
| Installation travel check position                 | Latest report or answer position rounded to about 1 km, kept for 24 hours                                                                                                                                                                |
| Road-report private drafts                         | Only while sharing is off or unavailable: up to 25 structured report types, precise coordinates, creation times, and expiry times stored only on the device; each expires after two hours and all are removed with the app               |
| Google-enabled place component                     | Selected public POI name and coordinate sent directly to Google; response not retained by NavOSS. Google's embedded manifest separately declares the SDK data categories and purposes listed above under Google's retention controls     |
| Google query safety counter                        | UTC month, aggregate used count, and last update time retained in the NavOSS database; contains no place, coordinate, account, device, or search data                                                                                    |
| Place and ETA share text                           | Created on the phone and not sent to NavOSS; controlled by Apple and the user-selected share destination                                                                                                                                 |
| Public Calgary business and parcel search index    | Current local mirror refreshed every 24 hours; reproducible index tables are excluded from logical backups                                                                                                                               |
| API and service operational logs                   | Maximum seven days; routine HTTP access logging is disabled                                                                                                                                                                              |
| Host authentication and firewall security logs     | Maximum seven days; may contain timestamp, source IP and port, local account, action, and outcome                                                                                                                                        |
| Report database backups                            | Maximum 14 days; may contain accepted beta contributions but do not contain route or search requests or traffic speeds                                                                                                                   |
| Support messages                                   | Controlled by Apple or GitHub according to the channel selected by the user and that provider's policy                                                                                                                                   |

NavOSS operational logs are limited to timestamps, service/container identity, severity, lifecycle events, health failures, error names, and random request IDs where needed. The NavOSS API's own logs exclude HTTP request and response bodies, search text, route coordinates, shared traffic positions, and normal HTTP access events. NavOSS has not yet verified that the routing software and the reverse proxy never log request content or client addresses when a request fails; traffic publication stays off until it has. When traffic sharing is enabled on the server, a periodic summary records only counts of batches, credentials, and road stretches, with no road, position, address, or installation. All six production containers write to the host journal, which enforces a seven-day and 512 MiB limit. Caddy access logs and automatic Fastify request logs are disabled.

Cloudflare and OpenFreeMap apply their own retention policies to data they process. Cloudflare's policy does not promise one fixed period for all end-user network/security data. OpenFreeMap states that anonymized logs may be retained indefinitely and incident IP logs for at most 30 days. These provider-controlled periods are not part of NavOSS's seven-day host limit.

## Choices and deletion

You can deny or revoke location in iOS Settings. Search and map browsing remain available, but current-position routing and active navigation will be limited. You can stop an active trip using End navigation, which stops background location and erases the transient active route.

You can erase all locally stored recent and saved destinations at any time using **Clear saved and recent destinations** in the app's About and Privacy screen. Pending contribution retries can be deleted individually on the Contribute screen. Accepted beta feedback cannot be linked back to an account because NavOSS has no account or contributor identifier; contact support with the random submission ID if deletion before automatic expiry is required. Road-report private drafts expire after two hours. **Reset community identity** deletes this installation's shared road reports and answers from the server, as described under [Community road reports](#community-road-reports). Removing the app removes all remaining local records.

You can use NavOSS without granting Contacts access because the app never asks for it. Sharing and the external reviews link are optional, user-initiated actions. Dismissing the system share sheet sends nothing to a recipient. In a Google-enabled build, opening a POI sheet can send its public coordinate for Google-rendered photos, ratings, and reviews; choosing no external reviews link sends no Google Maps search.

Traffic sharing is optional and off by default; turn **Share traffic speeds** off in About and Privacy to stop it, as described under Traffic sharing above.

Because NavOSS has no account and does not retain server-side search, route, or trip records, it normally has no server history that can be exported or deleted. Published traffic speeds are stored without an account, installation, or trip identifier and only as short-lived per-road values once at least three installations have driven a stretch (their speeds are combined into a median; they are not checked for agreement). Speeds waiting for publication are held only in memory, under markers the running server could recompute from an installation. The residual ways a contribution could still be inferred are listed under Traffic sharing above. The local recent- and saved-destination lists can be deleted in the app as described above. A rights request may identify a support message or a recent security event. Include only enough information to locate that record. NavOSS may be unable to associate an IP-only, transient request with a person. Requests about Cloudflare, OpenFreeMap, Apple, or GitHub data may also need to be directed to that provider.

## Children

NavOSS is a general-audience navigation utility and is not directed to children. It does not create profiles or knowingly maintain children's personal information. A parent or guardian should supervise a minor's use of navigation and support channels.

## Security and international processing

App-to-API traffic uses HTTPS through Cloudflare. The origin is reachable through an outbound tunnel rather than a public inbound port. The host uses key-only SSH, a default-deny firewall, encrypted transport, least-privilege containers, read-only filesystems where practical, security updates, bounded logs, and encrypted provider connections where applicable.

The NavOSS origin is in Alberta, but Cloudflare, OpenFreeMap, Apple, Google when place details are enabled or the external reviews link is chosen, GitHub, and a user-selected share destination may process data outside Canada as described in their policies. No security measure can guarantee absolute protection.

## Changes

Material changes will be posted at this URL with a revised effective date. During beta testing, material data-use changes will also be called out in TestFlight release notes before the changed feature is tested.
