# CI/CD and App Store Delivery

## Policy

NavOSS does not publish an App Store update from every commit. Navigation changes need review, automated checks, TestFlight evidence, and Apple App Review.

The delivery path is:

1. Pull request or push to `main`: run formatting, type checks, lint, tests, builds, license-notice freshness, and native Swift tests.
2. Publish an `ios-v<app-version>` GitHub release: queue the EAS `production-carplay` build and automatic TestFlight submission.
3. Test the processed build using the internal TestFlight group.
4. Manually select the validated build in App Store Connect, complete metadata, and submit it for App Review.
5. Choose manual, automatic-after-approval, or phased release in App Store Connect.

EAS Submit sends iOS builds to TestFlight. It does not submit them for public App Store review.

## Local PR review

**There is currently no automatic PR review.** The GitHub Action was removed because it required an
`ANTHROPIC_API_KEY` the repository does not have, and the launchd replacement was uninstalled after
it was found unable to authenticate. Review runs only when invoked by hand:

```sh
scripts/review-ready-prs.sh
```

That works, and has real findings to its name: it rejected #27 twice, catching a circular
measurement, a mislabelled leg boundary, and two tests that could not fail.

It selects non-draft, non-Dependabot pull requests whose named checks have all succeeded, and
reviews each head SHA once. The agent receives the pull-request metadata and diff as untrusted
files and is restricted to `read`, `grep`, and `glob`: it cannot edit the checkout, run commands, or
post to GitHub. The wrapper validates the `VERDICT:` line, posts the comment, and writes a hidden
reviewed-SHA marker. A lock, a pre-post head re-check, and a duplicate check make it safe to run
repeatedly or concurrently.

### Why the timer is not installed

`scripts/install-local-pr-reviewer.sh` installs a launchd job that polls every two minutes. It is
deliberately **not** installed, because OMP's model credential on this machine is supplied per
session rather than stored: under launchd the agent exits zero having produced nothing, so the job
loops without ever posting a review. Copying a session credential into a LaunchAgent file is not an
acceptable fix.

To make the timer viable, give OMP a durable credential first, either by configuring an auth broker
(`OMP_AUTH_BROKER_URL` with `omp auth-broker login`) or by exporting a provider key from a shell
profile and wrapping the job in a login shell. Install the job only after
`env -i HOME="$HOME" /bin/zsh -lc 'omp -p "reply OK"'` succeeds, which is the condition launchd
actually runs under.

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
7. Create an Expo access token at <https://expo.dev/settings/access-tokens>. This cannot be
   automated: `eas-cli` exposes only `account:audit`, `login`, `logout`, `usage`, and `view`, with
   no token-provisioning command, and the local CLI login is a browser session credential that the
   API rejects when presented as `EXPO_TOKEN`. Being logged in with `eas whoami` is therefore not
   sufficient to give CI credentials; someone has to mint the token in the browser.
8. In GitHub, create an `app-store-production` environment and add `EXPO_TOKEN` as an environment secret. Add protection rules before other maintainers receive release access.
9. Run the `iOS TestFlight` workflow manually once before relying on GitHub release triggers.

Apple credentials belong in EAS credential storage or App Store Connect, not in the repository or normal GitHub Actions secrets. Never commit `.p8`, provisioning profile, certificate, Expo token, or Apple password files.

## Release Procedure

`EXPO_TOKEN` is configured in the `app-store-production` environment, and the GitHub path was
verified end to end on 2026-09-02. Run 33616401716 passed every step including the token guard,
queued build 52, and that build reached TestFlight: EAS build `FINISHED`, submission `FINISHED`,
and App Store Connect reporting `0.1.0 (52)` in beta testing. It is the first build in this
project's history produced by CI rather than from a local EAS session, which is what issue #24
reported.

That is a dated observation, not a guarantee. An Expo token can be revoked or expire, and the
workflow fails closed at its guard when that happens, so treat a red `Require Expo token` step as
the token needing renewal rather than as a workflow regression.

Releasing from a machine with an EAS session also still works, and is the fallback when the
workflow is unavailable:

```sh
cd apps/mobile
eas build --platform ios --profile production-carplay --auto-submit --non-interactive
```

`eas submit --groups` adds a build to internal groups only. External distribution goes through the
TestFlight workflow job in `apps/mobile/.eas/workflows/`; on the free plan use the
`asc_build_id` variant, because the `build_id` variant requires a paid plan.

1. Update `expo.version` in `apps/mobile/app.json`. EAS remotely increments the iOS build number.
2. Merge only after CI passes.
3. Create a GitHub release with the exact tag `ios-v<expo.version>`, such as `ios-v0.1.0`.
4. Watch the GitHub workflow until EAS accepts the build request, then monitor the EAS build/submission dashboard.
5. Wait for App Store Connect processing and complete export-compliance prompts.
6. Install from TestFlight with Metro disconnected and run the release smoke suite.
7. Promote the tested build manually for external TestFlight or App Review.

Before promotion, audit the signed IPA for the approved `com.apple.developer.carplay-maps` entitlement, the CarPlay template scene, the `location` background mode, and the production API origin.

The workflow rejects a tag that does not match `apps/mobile/app.json`.

## Over-the-Air Updates

EAS Update is intentionally not enabled yet. It can deliver compatible JavaScript and asset changes without a new binary, but it cannot change native code and it must comply with Apple policy. Automatic production OTA updates are too risky for an early navigation app.

When enabled later, use preview/staging channels first, runtime-version compatibility, an explicit promotion step, and rollback evidence. Do not publish safety-critical navigation changes directly from every merge.
