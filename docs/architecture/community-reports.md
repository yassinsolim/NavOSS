# Community road-report trust model

Decision date: 2026-07-27

## Decision

Community road reports will launch in shadow mode before any report is visible to another driver.
The first report types are collision, road closure, road hazard, and stalled vehicle. NavOSS will not
accept police, checkpoint, or speed-trap reports, free text, photos, public usernames, rankings, or
rewards.

The first mobile slice records structured, two-hour local drafts during active guidance. It exists to
test placement and interaction only. These drafts are not sent to NavOSS and are not shown to other
drivers.

## Identity and abuse resistance

The production write path will use a pseudonymous installation identity backed by Apple App Attest,
not an account:

1. The app creates a Secure Enclave/App Attest key and requests a one-use server challenge.
2. The server verifies the attestation and issues an internal installation identifier.
3. Every report, confirmation, and deletion request carries a fresh assertion and monotonic counter.
4. Server-side limits apply per installation, network risk bucket, category, and geographic cell.
5. Replayed assertions, impossible travel, self-confirmation, duplicate votes, and coordinated bursts
   are rejected or quarantined.

Navigation remains account-free and usable when App Attest is unavailable. Report writing fails
closed or receives a much lower untrusted limit; report reading does not require an identity.

## Credibility

Credibility is an internal confidence weight, never a public score. New installations begin with low
influence. The score changes only after independent outcomes, decays when evidence becomes stale,
and penalizes contradicted or coordinated reports more strongly than it rewards agreement.

A conservative Beta posterior is suitable for the first implementation. Given weighted supporting
evidence $s$ and contradicting evidence $f$, the internal mean is:

$$
\operatorname{credibility} = \frac{\alpha_0 + s}{\alpha_0 + \beta_0 + s + f}
$$

The displayed decision must also use a lower confidence bound and minimum independent-device count;
the mean alone cannot publish a report. App Attest fraud-risk signals are evidence, not automatic
bans.

## Confirmation and expiry

- The app asks **Still there?** only after a device passes the event, never before or near a maneuver.
- Choices are **Present**, **Not present**, and **Dismiss**.
- The server verifies a fresh nearby coordinate, records only the proximity result needed for abuse
  controls, and discards the raw observation coordinate after that check.
- A reporter cannot confirm their own event. One installation gets one effective vote per event.
- A report remains hidden until it has enough independent weighted support or a trusted reporter plus
  corroborating evidence.
- Contradictions suppress an event quickly. Collision, hazard, and stalled-vehicle reports expire in
  at most two hours unless independently reconfirmed. Closures require stronger evidence and an
  operator review before they can influence routing.
- Community reports are always visually and contractually distinct from official municipal data.
- No single community report automatically changes a route.

## Rollout

1. **Local interaction test:** structured, expiring drafts on the reporting phone only.
2. **Attested shadow mode:** accept reports server-side, score and moderate them, but expose none to
   drivers.
3. **Confirmation beta:** ask passing internal testers for present/not-present evidence.
4. **Read-only community overlay:** display independently corroborated events with source and age.
5. **Routing consideration:** only reviewed closures may affect routing, behind a kill switch.

Before stage 2, add PostGIS migrations, least-privilege runtime and migration roles, exact row and
backup retention, identity deletion, moderation tooling, rate limits, App Attest replay tests,
privacy-policy and App Privacy updates, and incident-response controls. CarPlay reporting is deferred
until the phone workflow has on-road evidence and a separate distraction review.
