# Copy: wording rules

Applies to phone text, CarPlay templates, spoken guidance, accessible names and the website. Rules carry IDs so a review can cite them.

## rule/claim-matches-deployed-service

User-facing text may claim only what the **deployed** service and the **shipped build** do. A capability merged on `main` but not deployed (Alberta+BC coverage, `/v2/routes` lanes and signposts, community reports, community traffic, offline bundles) must not be described as available, including in App Store metadata and the site. Evidence: `AGENTS.md` ("Current checkpoint"), `docs/release/next-build-checklist.md`.

## rule/coverage-from-the-server

Coverage wording comes from what the server declares (`/v2/config`), never from a constant in a view. Evidence: #84; `exploreServiceNotice` takes `coverageName`.

## rule/traffic-stated-as-it-is

Say "No live traffic" unless the route response carries live traffic; say "No live traffic on this route" when traffic exists elsewhere but not here. Evidence: `route-progress.ts` (`routeTrafficLabel`).

## rule/privacy-copy-matches-the-policy

Text about what is sent, stored or shared must agree with `docs/privacy.md` and, for the site, `apps/site/src/privacy.html`. Do not call community traffic "anonymous": the policy says it is "data minimisation with a threshold, not anonymity".

## rule/private-until-shared

A report control says before the driver commits whether it is shared: "Report (private)" and "Report to drivers", "Saved privately on this iPhone" and "Shared with other NavOSS drivers". Evidence: `CommunityReports.swift`.

## rule/official-not-crowd

Official data (City of Calgary cameras, DriveBC and Ontario 511 events) is labelled as official; community reports are "unconfirmed" until confirmed and never officially sourced; incident markers from Calgary are labelled unverified. Never add police, speed-trap or checkpoint wording (`docs/data-sources.md`).

## rule/driving-safe-wording

- Short first: distance, then action, then where it leads. Never truncate the action (#78 maneuver banner).
- No instruction that needs reading while moving beyond the maneuver itself. Anything longer is for a parked or passenger moment.
- Do not encourage speeding or evasion. Speed warnings state the limit; camera alerts say "Red light and speed camera ahead".
- Spoken text: natural en-CA phrasing ("metres", "1.5 kilometres"); say what the signs say only when the route carries it; never read absent data (#75, #84).

## rule/name-the-object-and-consequence

Controls name the object and the effect: "Reset community identity", "Clear saved and recent destinations", "Share road reports". Avoid "OK", "Confirm", "Submit" alone. Choices that change a route say how: "Use new route" and "Keep mine" (CarPlay), "Accept new route" and "Keep route" (phone).

## rule/no-blame-no-codes

Errors say what happened and what to do, in plain language: "No connection. Try again in a moment." Do not show status codes, error enums or "invalid request".

## rule/no-hype

No "best", parity claims, competitor names or irrelevant AI claims (`docs/release/app-review.md`, `docs/release/app-store-metadata.md`). The product is "account-free", "open source", "technical beta". The website's roadmap section labels unreleased work "In development" and states what is true today next to it (`apps/site/test/site.test.mjs` keeps live-traffic, offline and community wording out of the "In the app today" section).

## Writing style

- Sentence case. One idea per sentence. `NavOSS` is not translated (`translate="no"` on the site).
- Numbers with units, rounded for glances. Never invent an ETA or a distance.
- Accessible names say what the control does, not how it looks, and match visible labels where one exists ("Center map on my location", "Resize sheet").
