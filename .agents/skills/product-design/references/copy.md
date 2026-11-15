# Copy: wording rules

Applies to phone text, CarPlay templates, spoken guidance, accessible names and the website. Rules carry IDs so a review can cite them.

## rule/claim-matches-deployed-service

User-facing text may claim only what the **deployed** service and the relevant **build** do. The service supports Canada-wide search and routing and `/v2/routes` lanes and signposts when returned. Build 82 was distributed to testers on 2026-11-15; build 70 uses v1. Reports are `attested` and opt-in traffic is `collect`: build 80 onward can share, earlier builds cannot. Verified reports are unconfirmed until corroborated; collected traffic is not displayed or used in routes. Live traffic remains unavailable. Alberta and Calgary-area offline regions are available; BC has no offline region. Province-wide road events for Alberta, BC and Ontario are in distributed builds 81 and 82, not builds 75 or 80. Evidence: #120, #121, #125, `AGENTS.md`.

Builds 75 and 80 follow the server's declared areas for search and routing (their shipped
`client-config.ts`, route planner and native `NavigationServerConfig.swift`); this is code evidence,
not an on-screen Canada validation.

## rule/coverage-from-the-server

Coverage wording comes from what the server declares (`/v2/config`), never from a constant in a view. Evidence: #84; `exploreServiceNotice` takes `coverageName`.

## rule/traffic-stated-as-it-is

Say "No live traffic" unless the route response carries live traffic; say "No live traffic on this route" when traffic exists elsewhere but not here. Evidence: `route-progress.ts` (`routeTrafficLabel`).

## rule/privacy-copy-matches-the-policy

Text about what is sent, stored or shared must agree with `docs/privacy.md` and, for the site, `apps/site/src/privacy.html`. Do not call community traffic "anonymous": the policy says it is "data minimisation with a threshold, not anonymity".

## rule/private-until-shared

A report control says before the driver commits whether it is shared: "Report (private)" and "Report to drivers", "Saved privately on this iPhone" and "Shared with other NavOSS drivers". Evidence: `CommunityReports.swift`.

## rule/official-not-crowd

Official data (City of Calgary cameras, DriveBC, City of Toronto, 511 Alberta and Ontario 511 events) is labelled as official; 511 Alberta and Ontario 511 were connected in production on 2026-11-15. Community reports are "unconfirmed" until confirmed and never officially sourced; incident markers from Calgary are labelled unverified. Never add police, speed-trap or checkpoint wording (`docs/data-sources.md`).

## rule/driving-safe-wording

- Short first: distance, then action, then where it leads. Never truncate the action (#78 maneuver banner).
- No instruction that needs reading while moving beyond the maneuver itself. Anything longer is for a parked or passenger moment.
- Do not encourage speeding or evasion. Speed warnings state the limit; camera alerts say "Red light and speed camera ahead".
- Spoken text: natural en-CA phrasing ("metres", "1.5 kilometres"); say what the signs say only when the route carries it; never read absent data (#75, #84).

## rule/one-road-name

A road is shown and spoken by one name: its first posted name (the street sign; English first on Ontario's bilingual signs), or its route number when it has no name. Official and translated names are dropped ("Highway 401 Express", not "Highway 401 Express; Macdonald-Cartier Freeway"; "Wellington Street", not "Wellington Street; rue Wellington"). Written instructions keep a route number beside the name only when the name does not carry it ("15/Autoroute des Laurentides"); spoken instructions say the name only, and a chained cue continues in lower case ("… Then bear right onto …"). The server applies it (`apps/api/src/road-names.ts`), so shipped builds get it without an update.

## rule/name-the-object-and-consequence

Controls name the object and the effect: "Reset community identity", "Clear saved and recent destinations", "Share road reports". Avoid "OK", "Confirm", "Submit" alone. Choices that change a route say how: "Use new route" and "Keep mine" (CarPlay), "Accept new route" and "Keep route" (phone).

## rule/no-blame-no-codes

Errors say what happened and what to do, in plain language: "No connection. Try again in a moment." Do not show status codes, error enums or "invalid request".

## rule/no-hype

No "best", parity claims, competitor names or irrelevant AI claims (`docs/release/app-review.md`, `docs/release/app-store-metadata.md`). The product is "account-free", "open source", "technical beta". The website's roadmap section labels unreleased work "In development" and states what is true today next to it (`apps/site/test/site.test.mjs` guards live-traffic wording, Alberta-only offline coverage, and build-qualified report sharing). Evidence: #119, #120, #122.

## Writing style

- Sentence case. One idea per sentence. `NavOSS` is not translated (`translate="no"` on the site).
- Numbers with units, rounded for glances. Never invent an ETA or a distance.
- Accessible names say what the control does, not how it looks, and match visible labels where one exists ("Center map on my location", "Resize sheet").
