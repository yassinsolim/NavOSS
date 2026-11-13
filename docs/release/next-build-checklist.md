# Next build checklist

Status: written 2026-11-12. The latest shipped build is `0.1.0 (70)` from `afa4067`. No later build has been created. This checklist is for the next candidate and for the server changes that must follow it. It states conditions; it does not claim any of them is met unless it cites evidence.

Context: `main` contains the phone UI refresh (#78), native contract v10 (#75, #84), the CarPlay quality pass (#77), `/v2/routes` clients (#84) and the community reports and traffic client (#85). The deployed production service (`https://navoss-api.yassin.app`) still runs the older API image (Calgary and Kelowna; no `/v2/routes`, community, traffic or offline manifest) and cannot be redeployed yet. The next build must work against it.

## 1. Pre-upload conditions

- [ ] **Works against the old production server.** The candidate commit, not an earlier one, runs on the simulator against `https://navoss-api.yassin.app`: config accepted, search, route preview with alternatives and "No live traffic", guidance without lanes, camera alert, reroute, arrival, and no community or traffic request beyond one `/v2/config` and one `/v2/traffic/status` probe. Evidence so far: #84 (phone and CarPlay, simulator, production config) and #85 (simulator through a write-blocking proxy to the production API; unit test for a server answering 404 on `/v2/community/*` and `/v2/traffic/*`). Neither was run on a later candidate commit. The offline manifest (#83) must also degrade quietly when `/v1/offline/manifest` is 404 or 503.
- [ ] **App Attest capability on the App ID**, and EAS capability sync. The plugin writes `com.apple.developer.devicecheck.appattest-environment` as `production` for every EAS profile except `development`, and a Release build with `development` fails an Xcode build phase. Confirm the capability on App ID `org.navoss.mobile` in the Developer portal and that the EAS build log shows it synced; confirm `production` in the signed archive's entitlements.
- [ ] **Release exclusions.** Run `apps/mobile/scripts/check-release-exclusions.sh` against the Release archive: the DEBUG-only software App Attest key and simulator harness code must be absent from device builds.
- [ ] **Privacy manifest.** The app privacy manifest, SDK manifests, App Store Connect App Privacy answers and the permission string agree. Once #83 merges, the manifest declares the required-reason Disk Space category (#83 adds `NSPrivacyAccessedAPICategoryDiskSpace` to `app.json`; verify it in the archive). The permission string and App Privacy changes for community features are in [app-store-metadata.md](app-store-metadata.md#app-privacy-answers-needed-before-community-features-are-enabled); they must be in place before the server enables community features, and are best shipped in this build.
- [ ] **External distribution is manual (#88).** The upload reaches the internal `testers` group only. Do not run `testflight-distribute.yml` until the head-unit checklist below has a result you are willing to put in front of friends. Verify in EAS that the old upload trigger is deregistered; that was not verified.
- [ ] **Build number.** `appVersionSource` is `remote`: EAS increments the number from its own counter (the last shipped is 70). Record the actual number and commit in [testflight.md](testflight.md) after the build exists, not before.
- [ ] **Gates on the candidate commit:** `corepack pnpm check`, `lint`, `test`, `build`, `format:check`; `corepack pnpm --filter @navoss/mobile test:native:ios`; a full Xcode compile with CarPlay enabled; `corepack pnpm validate:navigation:ios`. Read each command's exit status.
- [ ] **Claims.** App Store metadata, What to Test and review notes say lane guidance, live traffic, shared reports, Alberta and British Columbia coverage and offline maps are **not available** unless the server has been deployed, enabled and verified (section 3).
- [ ] CarPlay entitlement, template scene, `location` background mode and production API origin audited in the signed IPA (existing audit in [ci-cd.md](ci-cd.md)).

## 2. Head-unit checklist

Run on an entitled physical head unit, parked or passenger-operated. Record build number, phone, iOS version, vehicle and wired or wireless. Do not record route coordinates or trip history. Interactive CarPlay has never been exercised on the maintainer's Mac (Xcode 27.2 has no CarPlay Simulator window), so every item below is unverified until run.

### A. CarPlay quality pass (22 items: the 19 from the PR #77 report plus the 3 added after its core integration)

1. Connect with the phone locked: the map opens on your position, not central Calgary, within a few seconds.
2. Search > Gas: a list appears at once saying "Searching…", then fills nearest first with distances.
3. Mic in Search, say "Navigate to Calgary Tower": the result list opens immediately and fills. Car radio comes back after recording.
4. Turn off Dictation and try voice: the failure screen offers retry, Type a destination, and Home/Work/recents.
5. Preview with alternatives > Go: guidance starts, and the map follows heading-up with the car beside the turn card.
6. Approach a turn: the card symbol matches the junction, "then" appears for close turns, a white arrow sits on the road, and the bottom label names the road you're on.
7. Roundabout: the card shows the numbered exit, and the map arrow follows the circle.
8. Speed through a known limit: the badge turns red at 5 km/h or more over, and never with an unknown limit.
9. Leave the route: the "New route" alert shows and guidance continues.
10. Switch to Music mid-preview and back: the preview and its route choices are still there.
11. Report button > a type: back on the map within two taps with a "saved privately" banner (against the old server: "Kept privately on this iPhone. Not shared with other drivers.").
12. Trip > Stops > a stop > Remove: alternatives show, and the old trip guides until you choose.
13. Arrive: the "You've arrived" alert stays, and Done ends the trip on both CarPlay and the phone.
14. Spoken prompts over music: the music dips only during the prompt and comes back afterwards.
15. Dusk or headlights on: the map switches to dark.
16. Dashboard: the route, arrow and speed show; Go and Voice open NavOSS.
17. Car with a cluster or HUD: the NavOSS map appears there, and the car's zoom controls work.
18. Siri, "Navigate to Home with NavOSS": routes appear on CarPlay and nothing starts until you tap Go.
19. Disconnect and reconnect mid-trip: guidance, turns and the route are restored.
20. Ask-first reroute: with Rerouting set to Ask first, leave the route; the alert states the real time and distance change; tap **Use new route** once and **Keep mine** once.
21. Camera banner and marker on approach to a Calgary intersection safety camera.
22. Settings: change **Rerouting** and **Speeding warning** from CarPlay; the phone's Guidance settings follow.

Carried-over open items from [testflight.md](testflight.md) (builds 54 and 70): vehicle-microphone voice search after permission approval, head-unit music restoration, cornering and wake-without-jump with the handset locked, reconnect while locked, Dashboard-only, and the route-preview Start control at the largest accessibility text size. The Copilot review on #77 also raised three cases worth trying: a multi-arrow lane that lacks an active indication must not highlight "straight" for a right turn; a Siri shortcut to a place that is not in the saved-place catalog after a restart; and "Home" and "Work" queries when the saved place has a different name.

### B. Community checks (only against a build that contains #85 and a server where the feature is on)

Against the **old** production server (this build, no server change):

- [ ] CarPlay Settings > Community shows Share road reports, Share traffic speeds and Spoken road reports, all off. Turning on Share traffic speeds shows "Not available yet" and nothing is uploaded.
- [ ] The report grid is titled "Report (private)" and a report stays a private draft.

Against a server with reports enabled (publication `attested`, App Attest configured):

- [ ] First shared report registers the installation (real App Attest on a physical iPhone: this has **never** been run; #85 verified only the simulator's development key).
- [ ] With Share road reports off the grid says "Report (private)"; with it on, "Report to drivers".
- [ ] A report within 400 m of saved Home or Work, or a trip's start, destination or stop, stays private and says why.
- [ ] A shared report appears as an unconfirmed marker on the CarPlay map and the phone map; a second installation's "Still there" makes it confirmed; "Not there" removes it.
- [ ] Report-ahead banner at most once per trip within about 800 m; spoken alert only with Spoken road reports on and sound mode allowing it.
- [ ] "Still there?" is a `CPNavigationAlert` shown only after passing a report, never near a turn, never over another alert; Dismiss and timeout send nothing; the alert withdraws if a maneuver comes near (reviewed in code only so far).
- [ ] **Reset community identity** (phone) deletes the installation, its reports and answers; a later report registers a new key.
- [ ] Traffic: with Share traffic speeds on, a new installation shows "starts tomorrow"; after a day, uploads occur only during turn-by-turn; the first and last 400 m of a trip and the area around stops are not uploaded (needs server-side evidence, not only the app).

### C. Offline checks (only after #83 merges and bundles are hosted)

- [ ] The Offline maps sheet says the feature is not available when the manifest endpoint is 404 or 503 (the state on today's production).
- [ ] Download, pause, resume, update and delete a region; free-space check; the bundle is excluded from iCloud backup.
- [ ] In airplane mode: offline map, address and category search, an offline route with alternatives labelled as offline, guidance, off-route reroute computed on the device, CarPlay search and route preview.
- [ ] Route and search are online first when a network exists; the style falls back to the offline bundle when the hosted style fails.

## 3. Server enablement order

Follow [infra/compose/README.md](../../infra/compose/README.md) and the checklist in [community-traffic.md](../architecture/community-traffic.md#enablement-checklist). Each step names its evidence. Roll back by the method named in the same document.

1. **Record and prepare.** Record the running API image id and tag and tag it `navoss-api:pre-provincial-v2` (rollback). Keep the geospatial artifacts and additive migrations in place.
2. **Deploy the image and migrate.** `docker compose build api`, `docker compose run --rm --no-deps api node dist/migrate.js`, `docker compose up -d --no-build --wait api caddy`, then `./check-stack.sh`. Community features stay off: reports publication is `shadow` (the code default) and `COMMUNITY_TRAFFIC_MODE=off`.
3. **Verify with the 22-route matrix.** `/v1/config` still strictly v1 (`calgary-ab`, `/v1/routes`); `/v2/config` reports `alberta-british-columbia` and `/v2/routes`; a Calgary fixture request to `/v2/routes` returns exit 248 with lanes; `/ready` is ready and not degraded; then `NAVOSS_API_URL=https://navoss-api.yassin.app corepack pnpm --filter @navoss/api test:routes:alberta-bc` runs the complete 22-directed-route matrix. Confirm a build-70 client still routes (v1) before telling anyone the new clients can use `/v2/routes`. Only now may copy say Alberta and British Columbia coverage, lanes and signposts are available.
4. **App Attest.** Set `APP_ATTEST_TEAM_ID`, `APP_ATTEST_BUNDLE_ID=org.navoss.mobile`, `APP_ATTEST_ENVIRONMENT=production`, `COMMUNITY_ATTESTATION_MODE=enforce` and a secret of at least 32 random characters in `COMMUNITY_INSTALLATION_SECRET` (never rotate it casually: rotation orphans every installation). Never use `allow-development` on production. Writes answer 503 until both the team id and the secret are set.
5. **Reports publication.** Only after the build with the community client, the policy and the App Privacy answers are out: set `COMMUNITY_REPORTS_PUBLICATION=attested` for a small beta group, recreate `api`, confirm `/v2/config` shows `"communityReports":true`. Setting it back to `shadow` is the kill switch. `corroborated` is stricter.
6. **Traffic: collect, then live.** Keep `COMMUNITY_TRAFFIC_MODE=off` until the "Before `collect` with real drivers" group of the checklist is ticked (enforce mode, client audited against the client rules, Valhalla and Caddy logging verified on the host, swap and core dumps, monitoring, policy). Set `collect` and run `COMMUNITY_TRAFFIC_MODE=collect ./check-stack.sh`. Move to `live` only after "Before `live`" is ticked and the residual risks are accepted in writing.
7. **Publish the truth.** In the same change that enables a feature, update `docs/privacy.md` and the website privacy page to remove the statement that the feature is not switched on, update the site's "In development" cards and the README status table, and update App Store metadata.
8. **Offline hosting.** Provision storage for the bundles and publish the manifest (`NAVOSS_OFFLINE_MANIFEST_PATH`) and the bundles only after the app side (#83) has shipped in a build that was verified against the 404/503 state.
