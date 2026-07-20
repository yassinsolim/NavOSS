# NavOSS privacy policy

Status: **ready for internal TestFlight**. A direct privacy/support email must be activated before external beta testing.

Effective date: July 20, 2026

NavOSS is an account-free navigation application beginning with a Calgary technical beta. This policy explains how NavOSS uses data when you view the map, search for a place, request a route, navigate, or ask for support.

## Operator and contact

NavOSS is operated by Yassin Soliman as an individual developer in Alberta, Canada.

For a non-sensitive question, use the [public issue tracker](https://github.com/yassinsolim/NavOSS/issues). For a security issue or sensitive privacy request, use [GitHub's private vulnerability-reporting form](https://github.com/yassinsolim/NavOSS/security/advisories/new). Internal testers may also use TestFlight feedback, which is processed by Apple. Do not put an address, route, or other private information in a public issue.

The direct address `navoss@yassin.app` is not yet verified and is not presented as an active contact. External TestFlight and App Store submission remain blocked until direct delivery and reply handling are tested.

## Data used by the app

### Foreground location

When you grant location permission, NavOSS uses precise foreground location to display your position, choose a route origin, match your position to an active route, detect rerouting and arrival, and determine whether an official safety camera is ahead in the direction of travel.

Route requests send origin and destination coordinates to the NavOSS API. A reroute sends the latest route origin and destination. Valhalla routing runs on the same operator-controlled server as the API. Active route matching and camera eligibility run on the phone. The current beta does not request background location or maintain trip history.

### Search text

When you search, NavOSS sends the entered text and, when available, an approximate search origin to the NavOSS API in an encrypted request body. Search runs against self-hosted Nominatim and a local index of public City of Calgary business and parcel-address records on the same operator-controlled server. Search text and coordinates are not placed in public request URLs or written to the search index.

### Map and camera requests

The phone requests map styles, tiles, fonts, and sprites directly from the public OpenFreeMap service. OpenFreeMap therefore receives ordinary network information and the requested map resources, which can indicate the viewed map area. Its policy says regular logs are anonymized without IP addresses, while IP logging may be enabled during a security incident for no more than 30 days.

The phone obtains normalized safety-camera records from NavOSS. The NavOSS server refreshes the public City of Calgary Intersection Safety Cameras dataset every six hours and independently mirrors public business and parcel-address datasets every 24 hours. The phone and live search requests do not send location, search text, or route data to Calgary Open Data.

### Service and security data

NavOSS has no account, advertising, analytics, crash-reporting, data-broker, cross-app tracking, or runtime AI service. It does not use an advertising identifier or create a persistent user or device identifier.

Cloudflare provides public DNS, TLS termination, denial-of-service protection, and an outbound tunnel to the NavOSS server. Cloudflare necessarily processes the client IP address, request traffic, and routing/security metadata. NavOSS does not enable Cloudflare raw request-log export or store Cloudflare per-request access logs. Cloudflare may create and retain network or security data under its own privacy policy.

## Purposes

NavOSS uses data only to provide map rendering, search, routing, navigation, rerouting, arrival detection, safety-camera notices, service reliability, abuse prevention, security, and user-requested support.

NavOSS does not sell personal information or use it for advertising, marketing profiles, or cross-app tracking.

## Providers and processing locations

| Provider                                                                                           | Purpose and data                                                                                            | Location or policy                                                                  |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| NavOSS operator-controlled server                                                                  | API, Nominatim and indexed Calgary search, Valhalla routing, camera normalization, and operational security | Alberta, Canada                                                                     |
| [Cloudflare](https://www.cloudflare.com/privacypolicy/)                                            | DNS, TLS, traffic delivery, tunnel, and network security; processes IP and request traffic                  | Global network; Cloudflare describes international transfers in its policy          |
| [OpenFreeMap](https://openfreemap.org/privacy/)                                                    | Direct map style, tile, font, and sprite delivery                                                           | Hyperknot Software Kft. in Hungary, with infrastructure that may include Cloudflare |
| [Apple](https://www.apple.com/legal/privacy/)                                                      | TestFlight distribution and tester feedback when used                                                       | Under Apple's policy                                                                |
| [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) | Public issues and private vulnerability reports initiated by a user                                         | Under GitHub's policy                                                               |

Map and route data is derived from OpenStreetMap contributors. Search combines OpenStreetMap with the City of Calgary's public Business Licenses and Parcel Address datasets. Safety-camera records come from the City's public Intersection Safety Cameras dataset. Public Photon and FOSSGIS services are not used by the production API.

## Retention

| Data                                            | NavOSS retention                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Search text and search origin                   | Processed in memory for the response, then discarded; not written to a NavOSS database, access log, or backup        |
| Route and reroute coordinates                   | Processed in memory for the response, then discarded; not written to a NavOSS database, access log, or backup        |
| Trip progress and camera eligibility            | Processed on the phone and discarded when navigation ends; no trip-history database                                  |
| Public Calgary business and parcel search index | Current local mirror refreshed every 24 hours; reproducible index tables are excluded from logical backups           |
| API and service operational logs                | Maximum seven days; routine HTTP access logging is disabled                                                          |
| Host authentication and firewall security logs  | Maximum seven days; may contain timestamp, source IP and port, local account, action, and outcome                    |
| Report database backups                         | Maximum 14 days; community reports are currently disabled, and these backups do not contain route or search requests |
| Support messages                                | Controlled by Apple or GitHub according to the channel selected by the user and that provider's policy               |

NavOSS operational logs are limited to timestamps, service/container identity, severity, lifecycle events, health failures, error names, and random request IDs where needed. They exclude HTTP request and response bodies, search text, route coordinates, and normal HTTP access events. All six production containers write to the host journal, which enforces a seven-day and 512 MiB limit. Caddy access logs and automatic Fastify request logs are disabled.

Cloudflare and OpenFreeMap apply their own retention policies to data they process. Cloudflare's policy does not promise one fixed period for all end-user network/security data. OpenFreeMap states that anonymized logs may be retained indefinitely and incident IP logs for at most 30 days. These provider-controlled periods are not part of NavOSS's seven-day host limit.

## Choices and deletion

You can deny or revoke foreground location in iOS Settings. Search and map browsing remain available, but current-position routing and active navigation will be limited. You can stop an active trip using End navigation.

Because NavOSS has no account and does not retain search, route, or trip records, it normally has no history that can be exported or deleted. A rights request may identify a support message or a recent security event. Include only enough information to locate that record. NavOSS may be unable to associate an IP-only, transient request with a person. Requests about Cloudflare, OpenFreeMap, Apple, or GitHub data may also need to be directed to that provider.

## Children

NavOSS is a general-audience navigation utility and is not directed to children. It does not create profiles or knowingly maintain children's personal information. A parent or guardian should supervise a minor's use of navigation and support channels.

## Security and international processing

App-to-API traffic uses HTTPS through Cloudflare. The origin is reachable through an outbound tunnel rather than a public inbound port. The host uses key-only SSH, a default-deny firewall, encrypted transport, least-privilege containers, read-only filesystems where practical, security updates, bounded logs, and encrypted provider connections where applicable.

The NavOSS origin is in Alberta, but Cloudflare, OpenFreeMap, Apple, and GitHub may process data outside Canada as described in their policies. No security measure can guarantee absolute protection.

## Changes

Material changes will be posted at this URL with a revised effective date. During beta testing, material data-use changes will also be called out in TestFlight release notes before the changed feature is tested.
