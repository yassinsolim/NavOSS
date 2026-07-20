# NavOSS privacy policy draft

Status: **not ready to publish**. This draft contains required deployment and contact decisions.

Effective date: REQUIRED

NavOSS is an account-free navigation application beginning with a Calgary technical beta. This policy explains how NavOSS uses data when you search for a place, request a route, or navigate.

## Operator and contact

NavOSS is operated by Yassin Soliman as an individual developer.

Privacy contact: `navoss@yassin.app` (planned; forwarding and any legally required postal contact must be confirmed before publication)

## Data used by the app

### Foreground location

When you grant location permission, NavOSS uses precise foreground location to display your position, choose a route origin, match your position to an active route, detect rerouting and arrival, and determine whether an official safety camera is ahead in the direction of travel.

Route requests send origin and destination coordinates to the NavOSS API and its configured routing service. A reroute sends the latest route origin. The current beta does not request background location and does not save trip history in the app.

### Search text

When you search, NavOSS sends the entered text and, when available, an approximate search origin to the NavOSS API and its configured search service. This is used only to return relevant places and addresses.

### Service and security data

The app does not require an account and does not use advertising or cross-app tracking identifiers. The final production hosting design must document whether infrastructure providers process IP addresses, timestamps, response status, or security events and how long those records are retained.

REQUIRED BEFORE PUBLICATION: state the exact production access/security log fields and retention period. Request bodies, route coordinates, and search query strings must remain excluded from logs.

## Purposes

NavOSS uses data to provide search, routing, navigation, rerouting, arrival detection, safety-camera notices, service reliability, abuse prevention, and user-requested support.

NavOSS does not sell personal information or use it for targeted advertising.

## Service providers and public data

Production provider list: REQUIRED. Name the operators that host the NavOSS API, Valhalla routing, place search, map tiles, and operational monitoring, with links to their privacy terms.

Map and search data is derived from OpenStreetMap contributors. Safety-camera records come from the City of Calgary's public Intersection Safety Cameras dataset. The phone obtains normalized camera locations from NavOSS; it does not send your location to Calgary Open Data.

Public Photon and FOSSGIS services are development dependencies and must not appear as production subprocessors unless their operators explicitly approve that use.

## Retention

The app does not retain a trip-history database. Server retention: REQUIRED BEFORE PUBLICATION. State separate periods for transient request processing, security/access logs, support messages, and backups.

## Choices

You can deny or revoke foreground location in iOS Settings. Search and map browsing may remain available, but current-position routing and active navigation will be limited. You can stop an active trip using End navigation.

TestFlight feedback is processed by Apple and is also subject to Apple's privacy terms. Do not include private addresses or other sensitive information unless needed to investigate a report.

## Children

NavOSS is not directed to children. REQUIRED: confirm the legal age threshold and handling process for the operator's jurisdiction.

## Security and international processing

REQUIRED BEFORE PUBLICATION: describe hosting region, encryption in transit, access controls, incident contact, and any international transfers based on the final deployment.

## Changes

Material changes will be posted at this URL with a revised effective date. REQUIRED: define how beta testers will be notified.

## Contact and rights requests

Send privacy questions or access/deletion requests to `navoss@yassin.app` after the address is active. Because NavOSS has no account system, include only enough information to locate a support message or server record; NavOSS may be unable to associate transient navigation requests with a person.
