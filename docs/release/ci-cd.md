# CI/CD and App Store Delivery

## Policy

NavOSS does not publish an App Store update from every commit. Navigation changes need review, automated checks, TestFlight evidence, and Apple App Review.

The delivery path is:

1. Pull request or push to `main`: run formatting, type checks, lint, tests, builds, license-notice freshness, and native Swift tests.
2. Publish an `ios-v<app-version>` GitHub release, or dispatch `iOS TestFlight`: queue the EAS `production-carplay` build and automatic upload to App Store Connect.
3. The internal `testers` group automatically receives builds. The upload-triggered workflow in `apps/mobile/.eas/workflows/testflight-distribute.yml` is configured to assign eligible builds to `NavOSS Friends` and submit Beta App Review. See the activation status below before relying on automatic external delivery.
4. Manually select the validated build in App Store Connect, complete metadata, and submit it for App Review.
5. Choose manual, automatic-after-approval, or phased release in App Store Connect.

EAS Submit sends iOS builds to TestFlight. It does not submit them for public App Store review.

## Local automated PR review

`scripts/review-ready-prs.sh` runs a second, isolated OMP agent against every ready pull request.
It waits until the pull request is not a draft and all checks have finished successfully, then
reviews each head commit once. A synchronize event changes the head SHA and triggers a new review.
Dependabot is excluded because its mechanical updates are covered by lockfile validation and CI.

The agent receives the pull-request metadata and diff as untrusted files and is restricted to
`read`, `grep`, and `glob`; it cannot edit the checkout, run commands, or post to GitHub. The wrapper
posts the resulting `VERDICT:` comment and an invisible marker containing the reviewed SHA.

Install or refresh the per-user launchd job:

```sh
scripts/install-local-pr-reviewer.sh
```

It polls every two minutes while this Mac is awake and connected. Logs live under
`~/Library/Logs/NavOSS/`. This uses the locally authenticated OMP provider and GitHub CLI, so it
needs no repository model secret. It is intentionally local: when this Mac is asleep or offline,
reviews wait until it returns.

## One-Time Setup

Complete these steps after Apple Developer Program enrollment is active:

1. Create the App Store Connect app for bundle ID `org.navoss.mobile`.
2. EAS project `@yassinsolim/navoss` is linked with project ID `2a95b51d-dd23-431b-b941-fd80c13aadf5`.
3. Run the first production build interactively so EAS can establish the Apple Distribution certificate and provisioning profile:

   ```sh
   eas build --platform ios --profile production
   ```

4. Configure the App Store Connect API key through `eas credentials --platform ios`.
5. Add the numeric App Store Connect Apple ID as `submit.production.ios.ascAppId` in `apps/mobile/eas.json`.
6. `EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app` is stored in the EAS `production` environment and passes the release gate. Keep production builds blocked until App Privacy and account-holder questionnaires are complete.
   Google photos, ratings, and reviews remain disabled by default, and the standard production profiles explicitly set `NAVOSS_GOOGLE_PLACES_ENABLED=0`. To test them, enable Places UI Kit in a billing-enabled Google Cloud project, restrict an iOS key to `org.navoss.mobile` and the required API, and store it as the secret `GOOGLE_PLACES_IOS_API_KEY` in the EAS `production` environment. Use the explicit `production-carplay-google` build and submit profiles; they set `NAVOSS_GOOGLE_PLACES_ENABLED=1` and fail closed if the key is absent. An enabled artifact embeds Google Places SDK privacy declarations for location, Device ID, Other Data, performance, product interaction, and search history for analytics and/or app functionality. Reconcile App Store Connect, review notes, and the hosted policy before distribution. Never print or commit the key.
7. Create an Expo access token at <https://expo.dev/settings/access-tokens>.
8. In GitHub, create an `app-store-production` environment and add `EXPO_TOKEN` as an environment secret. Add protection rules before other maintainers receive release access.
9. Run the `iOS TestFlight` workflow manually once before relying on GitHub release triggers.

Apple credentials belong in EAS credential storage or App Store Connect, not in the repository or normal GitHub Actions secrets. Never commit `.p8`, provisioning profile, certificate, Expo token, or Apple password files.

## Release Procedure

The `app-store-production` GitHub environment has `EXPO_TOKEN` configured. The existing
GitHub workflow queues builds and uploads; EAS submission success is not proof of external
group assignment, Apple approval, or installation on a tester's device.

The local EAS entry point remains available:

```sh
cd apps/mobile
eas build --platform ios --profile production-carplay --auto-submit --non-interactive
```

`eas submit --groups` targets internal groups. The internal `testers` group already has
`hasAccessToAllBuilds=true`; do not pass it as an explicit group to an EAS TestFlight job.
External delivery uses `testflight-distribute.yml` with the App Store Connect build ID.
Its `asc_build_id` job was exercised successfully without purchasing a paid build-upload job.

1. Update `expo.version` in `apps/mobile/app.json`. EAS remotely increments the iOS build number.
2. Merge only after CI passes.
3. Create a GitHub release with the exact tag `ios-v<expo.version>`, such as `ios-v0.1.0`.
4. Watch the GitHub workflow until EAS accepts the build request, then monitor the EAS build/submission dashboard.
5. Wait for App Store Connect processing and complete export-compliance prompts.
6. Install from TestFlight with Metro disconnected and run the release smoke suite.
7. Confirm the build is assigned to `NavOSS Friends` and Apple reports `IN_BETA_TESTING` before calling it distributed. Public App Store review and release remain separate manual decisions.

Before promotion, audit the signed IPA for the approved `com.apple.developer.carplay-maps` entitlement, the CarPlay template scene, the `location` background mode, and the production API origin.

The workflow rejects a tag that does not match `apps/mobile/app.json`.

## TestFlight auto-distribution activation

The workflow handles App Store Connect `build_upload` events with state `complete` for app
`6792619727`, including uploads made outside GitHub Actions. It never starts a new binary build
on each source commit. A completed upload is not the same as a processed, approved beta;
processing or review failures must remain visible in EAS/App Store Connect.

Verified on 2026-09-07:

- EAS is connected to NavOSS's existing App Store Connect app and has its upload webhook.
- Internal `testers` receives all builds automatically. External `NavOSS Friends` contains builds
  16, 53, and 54. Recent builds have `autoNotifyEnabled=true`.
- The real recovery run `01a07e1b-60f7-7fa5-9eaa-a2795797b7f8` completed successfully against
  already-approved build 54, with Beta App Review resubmission disabled. Group scope stayed unchanged.

Activation prerequisites completed on 2026-09-08:

- The production Expo GitHub app (`github.com/apps/expo`) is installed on the account and scoped to
  **only `yassinsolim/NavOSS`**. The account previously had the unrelated
  `github.com/apps/expo-development` app installed, which is why the connection stayed unlinked.
- The repository is linked to the `navoss` project, and the base directory is saved as `/apps/mobile`.
- `eas integrations:asc:status` reports `connected` for `ascAppIdentifier` `6792619727`, matching the
  workflow's trigger guard.
- `eas workflow:list` registers `testflight-distribute.yml`, and the `app_store_connect.build_upload`
  trigger is on the default branch as of `54ce160`.
- **The event-triggered invocation is proven as of 2026-09-08/09.** Build 55's auto-submitted upload
  fired workflow run `01a08433-074e-7ae0-91bb-cc1d371e51b6` with `triggerEventType`
  `APP_STORE_CONNECT_BUILD_UPLOAD_STATE_CHANGED`, and its `Distribute to NavOSS Friends` job returned
  `SUCCESS` with no errors. That job enqueues the assignment and returns a
  `background_job_receipt_id`, so a `SUCCESS` here means the request was accepted, not that a tester
  can install the build. Apple-side processing, group membership, and Beta App Review still need
  confirming per build in App Store Connect.

Manual recovery for a missed event or an already-uploaded build:

```sh
cd apps/mobile
eas workflow:run .eas/workflows/testflight-distribute.yml \
  -F asc_build_id=<app-store-connect-build-id> \
  -F changelog="What testers should check"
```

For an already-approved build, add `-F submit_beta_review=false` to avoid resubmitting it.
Apple Beta App Review and export-compliance requirements are never bypassed.

### Testers' automatic installation setting

Each friend must enable **TestFlight → NavOSS → App Information → Automatic Updates**.
The developer can make a build available and enable notifications, but cannot force this
device setting or immediate installation. Existing testers do not need a new invitation for each build.
See [Apple's TestFlight guide](https://testflight.apple.com/#installing-testing).

## Over-the-Air Updates

EAS Update is intentionally not enabled yet. It can deliver compatible JavaScript and asset changes without a new binary, but it cannot change native code and it must comply with Apple policy. Automatic production OTA updates are too risky for an early navigation app.

When enabled later, use preview/staging channels first, runtime-version compatibility, an explicit promotion step, and rollback evidence. Do not publish safety-critical navigation changes directly from every merge.
