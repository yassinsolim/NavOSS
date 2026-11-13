# Product judgment

Use this before proposing UI. Write the brief in your plan; it does not need to be a file.

## The brief

| Question                   | NavOSS specifics to check                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Who is acting?             | A driver glancing while moving; a passenger operating; someone parked planning a trip; a CarPlay user with templates only.     |
| What job?                  | Find a place, choose a route, be guided, be told about a camera or hazard, tell others about a hazard, stop sharing.           |
| What object and scope?     | A place, a route, a report, a preference, an installation identity. Name it in the control's label.                            |
| What leaves the phone?     | Search text, route endpoints, a report coordinate, driven path (traffic). Each has a retention row in `docs/privacy.md`.       |
| What does it depend on?    | A server capability (`/v2/config` features, `/v2/traffic/status`), a native contract field, a permission, App Attest support.  |
| What if it is absent?      | The old production server answers 404 for all `/v2/*` community, traffic and route paths. Define the quiet fallback first.     |
| Consequence, reversibility | Can the user undo it? A shared report can be withdrawn only in the same app session; **Reset community identity** deletes all. |
| Success signal             | Observable on a render or a fixture, not "looks better". Name the state you will screenshot.                                   |
| Non-goals                  | What you will not touch (other surfaces, the server, copy owned by the policy).                                                |

## Rules of thumb that the code already follows

- **Strong defaults over settings.** Community sharing is off by default, with one switch each (`Share road reports`, `Share traffic speeds`, `Spoken road reports`); nothing is sent until the driver turns it on (#85).
- **Fail conservatively, say so quietly.** A capability the server does not offer shows as unavailable ("Not available yet" in CarPlay settings, "No live traffic" on a route) and never as an error.
- **Say what the route data is.** Route traffic reads "No live traffic" unless the response carries live traffic (`src/features/navigation/route-progress.ts`).
- **The server decides coverage.** Coverage wording follows what the server declares in its config, not a hard-coded region list (#84).
- **One owner per behaviour.** Matching, speech, rerouting and camera eligibility live in the native module. The phone presents them; do not re-derive them in JS.
- **Private near private places.** Reports within 400 m of saved Home or Work, or a trip's start, destination or stop, stay private unless the driver confirms (#85).

## When not to add UI

If a better default, a clearer sentence or reuse of `StateView` or `Banner` solves it, do not add a setting or a screen. Driving surfaces especially: every extra control is a distraction.
