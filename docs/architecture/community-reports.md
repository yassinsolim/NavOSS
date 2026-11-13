# Community road-report trust model

Decision date: 2026-07-27. Server implementation: 2026-11-12.

## Decision

Community road reports launch in shadow mode before any report is visible to another driver, then
open to a small group of beta drivers. NavOSS does not accept police, checkpoint, or speed-trap
reports, free text, photos, public usernames, rankings, or rewards.

Report types match the phone's structured draft types: `collision`, `road-closure`,
`slow-traffic`, `construction`, `pothole`, `object-on-road`, `road-hazard`, and
`stalled-vehicle`.

## Status

| Area                                                                       | State                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Phone: local two-hour drafts during guidance                               | Shipped. Drafts stay on the phone.                                       |
| API contracts, `/v2/community/*` routes, OpenAPI                           | Implemented (`packages/contracts/src/community-report.ts`).              |
| App Attest attestation and assertion verification                          | Implemented (`apps/api/src/app-attest.ts`).                              |
| PostGIS tables and explicit SQL migrations                                 | Implemented (`apps/api/src/migrations.ts`, `node dist/migrate.js`).      |
| Rate limits, replay, travel, self-vote, duplicate-vote controls            | Implemented (`apps/api/src/community-trust.ts`, `community-reports.ts`). |
| Beta-posterior credibility with decay, lower bound, device minimum         | Implemented.                                                             |
| Publication modes `shadow`, `attested`, `corroborated`                     | Implemented; `shadow` is the default.                                    |
| Native client: App Attest key, registration, submit, vote, withdraw, reset | Implemented (`ios/Core/Community*.swift`), shared by phone and CarPlay.  |
| Phone map layer, report sheet, "Still there?" sheet, reset control         | Planned (wave 2 phone slice, on the native bridge).                      |
| Privacy policy and App Privacy disclosures for shared reports              | Policy updated; App Privacy answers required before any build ships.     |
| Least-privilege runtime and migration database roles                       | Planned. Both currently use the `navoss` role.                           |
| Moderation tooling and operator review of closures                         | Planned.                                                                 |
| CarPlay reporting, markers, "Still there?" alert                           | Implemented; submits only while publication is live, else local drafts.  |
| Routing influence                                                          | Not implemented. No community report changes a route.                    |

## API

All routes are under `/v2/community` and tagged `community` in `/openapi.json`.

| Route                                | Purpose                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /challenges`                   | One-use 32-byte challenge, valid five minutes. Stored only as a SHA-256 hash.                                              |
| `POST /installations`                | Register an App Attest key (`kind: app-attest`) or, only when allowed, a development key.                                  |
| `DELETE /installations`              | Delete the asserting installation with all its reports and votes.                                                          |
| `POST /reports`                      | Submit a report. A same-type active report from another installation within 150 m is confirmed instead (`status: merged`). |
| `GET /reports?south&west&north&east` | Active reports in a box of at most 0.5° per side, under the publication policy. No identity needed.                        |
| `POST /reports/{id}/votes`           | `present` or `not-present` from a nearby installation.                                                                     |
| `DELETE /reports/{id}`               | Withdraw the installation's own report.                                                                                    |

Every write carries `{ keyId, challenge, assertion }`. The assertion is the CBOR object from
`DCAppAttestService.generateAssertion` over SHA-256 of `communityAssertionClientData(challenge,
operation)` (exported by `@navoss/contracts`), which binds the operation, the report id, the type,
the vote, and the coordinate to six decimals. Moving an assertion onto a different request fails
signature verification.

`/v1/config` and `/v2/config` report `features.communityReports: true` only when a database is
configured and publication is not `shadow`. No `/v1` response gained keys.

## Identity and abuse resistance

1. The app creates an App Attest key, fetches a challenge, and calls `attestKey` with
   SHA-256(UTF-8 challenge).
2. The server verifies `fmt = apple-appattest`, the `x5c` chain to Apple's App Attestation Root CA
   (pinned in code; tests inject their own root through an option and never relax the production
   check), certificate validity, the nonce extension `1.2.840.113635.100.8.2` against
   SHA-256(authData ‖ clientDataHash), SHA-256(public key) = key id = credential id, the RP id hash
   SHA-256(`<APP_ATTEST_TEAM_ID>.org.navoss.mobile`), counter 0, and the AAGUID for
   `APP_ATTEST_ENVIRONMENT`.
3. Each write consumes a challenge (burned even if the write then fails) and verifies the
   assertion signature, RP id hash, and a strictly increasing counter, updated atomically.
   Replayed requests fail on the challenge; replayed or rolled-back counters fail as replays.
   Assertion authenticator data is the 37-byte prefix even though real devices set the
   attested-credential flag in it. The signature is ECDSA P-256 with SHA-256 over
   `nonce = SHA-256(authenticatorData ‖ SHA-256(clientData))`, as Apple's "Validating apps that
   connect to your server" describes.

   Both conventions are checked against genuine Apple-signed attestations and assertions taken
   unchanged from the test suites of `veehaitch/devicecheck-appattest` (Apache-2.0) and
   `takimoto3/app-attest` (MIT, Apple's own published guide sample). Provenance and licences are
   in `apps/api/test/fixtures/app-attest/`. Those vectors are verified with the pinned production
   root.

   Still unproven until a NavOSS build registers from a real iPhone:
   - our team id and bundle RP hash;
   - the production AAGUID on a TestFlight build;
   - the Swift client's App Attest attestation and assertions from real hardware. Its client-data
     encoding is checked against vectors generated from `communityAssertionClientData`
     (`ios/Tests/Fixtures/community-client-data-vectors.json`), and its development-key
     assertions were accepted by a local server.

4. Limits:
   - Attested installations: 10 reports/hour, 3 of one type/hour, 30 votes/hour.
   - Untrusted installations: 2 reports/hour, 1 of one type/hour, 5 votes/hour.
   - At most 12 new reports per ~1 km cell in ten minutes, across all installations.
   - In-memory network risk buckets (IPv4 /24, IPv6 /48): 120 writes/hour, 240 challenges/hour,
     and 1,200 report reads/hour each.
   - Withdrawn reports still count toward their reporter's limits.
5. Rejected outright:
   - coordinates outside NavOSS coverage (the same predicate as search and routing);
   - impossible travel faster than 70 m/s between an installation's writes, with 2 km slack for
     the coarse stored position;
   - votes on one's own report;
   - a second vote on the same report;
   - votes more than 1.5 km from the report.

**Development mode.** App Attest does not work on Simulator.
`COMMUNITY_ATTESTATION_MODE=allow-development` lets a build register a software P-256 key
(`kind: development`). It still signs assertions in the same format and with the same counter
rules, but it is `untrusted`:

- It gets the lower limits above.
- Its reports are shadow-only: never returned, in any publication mode.
- Its votes are stored for analysis but never corroborate, contradict, extend, or shorten a
  report, and never change anyone's credibility.
- In `enforce` mode (the default) development keys can neither register nor authenticate, so
  installations admitted while development mode was on stop working once it is switched off.

**Concurrency.** Every write takes locks in one order:

1. per-cell advisory locks (submissions only: the 0.01° cell and its eight neighbours, in fixed
   order);
2. installation rows (ascending id, one statement);
3. the report row.

Vote evidence is read in a fresh statement after the report lock is held. Cell counts,
nearby-merge decisions, and inserts are therefore serialized across installations. A deadlock
or serialization failure is retried in-process up to three times. If retries run out, the
caller gets a retryable `503` with `Retry-After: 1`.

Navigation stays account-free and works without App Attest. Reading needs no identity.

## Credibility

Credibility is internal and never returned.

- **Installations.** Each installation's weight is its trust factor (1 attested, 0.25 untrusted)
  times the mean of Beta(2 + s, 2 + f). A new attested installation weighs 0.5. When another
  attested installation votes on its report, s grows by the voter's weight for `present`; f grows
  by twice that weight for `not-present`. Both decay with a 30-day half-life.
- **Reports.** Each report uses Beta(1 + S, 1 + F), where S is the reporter's weight plus present
  votes and F is the not-present votes, counting attested evidence only. Each piece of evidence
  decays with a 90-minute half-life. A report is **corroborated** when its lower bound
  (mean − 1·σ) is at least 0.4 and at least two distinct attested installations support it. One
  attested driver plus one confirming attested driver qualifies; untrusted confirmations never
  count.

## Publication (`COMMUNITY_REPORTS_PUBLICATION`)

- `shadow` (code default): accept, score, and store; return nothing. Submissions never merge with
  another installation's report, so a submission cannot reveal whether someone else reported the
  same place.
- `attested` (**beta setting** for a small group of TestFlight drivers): a report from an attested
  installation whose weight is at least 0.3 is returned as `state: unconfirmed, confirmations: 0`
  while its mean stays above 0.5. It becomes `state: confirmed` with the count of independent
  confirmations once corroborated. A single equal-weight "not there" hides it.
- `corroborated`: only corroborated reports are returned, as `confirmed`.

Returned reports carry `source: navoss-community` and are contractually separate from official
events. Reporter identity and credibility are never returned.

- **Position.** Published positions are snapped to a 0.0005° grid (about 55 m north-south by
  30–35 m east-west in Alberta and British Columbia). The snapped point is stored separately, and
  public bounding-box reads filter only on it, so narrowing the box cannot locate a report more
  precisely than the point returned.
- **Times.** `reportedAt` is rounded down and `expiresAt` up to five minutes.
- **Order.** Responses are ordered by random report id, never by creation time.

## Confirmation and expiry

- The app should ask **Still there?** only after passing the event, never near a maneuver. The
  choices are **Present**, **Not present**, and **Dismiss**; Dismiss sends nothing.
- A vote sends a fresh nearby coordinate. The server checks proximity and travel, keeps only an
  installation-level position rounded to about 1 km for the next travel check, and discards the
  vote coordinate.
- New reports expire after two hours.
  - `present` extends expiry to two hours from now, capped at 12 hours after creation.
  - `not-present` halves the remaining time.
  - Once weighted contradiction reaches twice the support, the report ends immediately.
- Closures will need stronger evidence and operator review before they can influence routing.
  No community report changes a route today.

## Privacy and retention

- Nothing about an installation is stored in the clear.
  - The key id is stored only as HMAC-SHA-256 under `COMMUNITY_INSTALLATION_SECRET`.
  - The credential public key is sealed with AES-256-GCM under a key derived from that secret and
    the key id. A database dump alone cannot link rows to a device's key.
  - No receipt, device model, IP address, or account is stored.
- Coordinates, key ids, and assertions are never logged.
- Purge runs every 15 minutes:
  - challenges at expiry;
  - reports and their votes 24 hours after expiry (withdrawn reports expire immediately);
  - the coarse last-write position after 24 hours;
  - installations after 90 days without a write.
- Deleting an installation removes its reports and votes immediately.
- Nightly logical backups keep the schema but exclude the rows of `community_*` tables.

## Known limitations

These are properties of the design, not verification failures.

- **Keys are not devices.** App Attest proves a key lives in a genuine app on genuine Apple
  hardware, not that two keys are on two different phones.
  - Reinstalling the app or deleting the installation yields a fresh key with fresh credibility.
  - A few cooperating attested installations can corroborate each other or farm credibility.
  - One equal-weight "not there" deliberately hides a fresh single report.
  - The App Attest receipt and fraud-risk metric, which can count keys per device, are not used
    yet. They are the planned mitigation before the overlay leaves the small beta group.
- **Location is client-asserted.** App Attest signs the coordinate the app sends; it does not
  authenticate GPS. Coverage, proximity, and impossible-travel checks bound a modified client
  only loosely.
  - The 2 km travel slack applies on every write.
  - A duplicate submission still updates the travel position before it returns.
- **Coarsening is not anonymity.** A grid point of about 55 m by 35 m plus a five-minute time
  still narrows a report made from a driveway to a handful of parcels, and outside observation
  can correlate it further.
  - The grid is the cheap mitigation chosen here. Snapping to the nearest road segment
    (Valhalla `/locate`) would move driveway reports onto the street, but it adds a network
    dependency on every submission and is left for later.
  - A database dump can still group raw positions by `installation_id`. Retention limits
    and the backup exclusion bound that exposure.
- **Secret rotation orphans installations.** After `COMMUNITY_INSTALLATION_SECRET` changes, old
  installations can no longer authenticate, including to delete themselves. Their rows remain
  until the 90-day inactivity purge.

## Rollout

1. **Local interaction test:** structured, expiring drafts on the reporting phone only (shipped).
2. **Attested shadow mode:** server accepts and scores, shows nothing (server ready; set
   `shadow`).
3. **Beta sharing:** `attested` publication for the small TestFlight group, with confirmation
   prompts.
4. **Read-only community overlay for everyone:** `corroborated` publication.
5. **Routing consideration:** only reviewed closures, behind a kill switch.

Setting publication back to `shadow` and recreating the API container is the kill switch. Deploy
and migration steps are in [`infra/compose/README.md`](../../infra/compose/README.md).
