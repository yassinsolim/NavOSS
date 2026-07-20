# CI/CD and App Store Delivery

## Policy

NavOSS does not publish an App Store update from every commit. Navigation changes need review, automated checks, TestFlight evidence, and Apple App Review.

The delivery path is:

1. Pull request or push to `main`: run formatting, type checks, lint, tests, builds, license-notice freshness, and native Swift tests.
2. Publish an `ios-v<app-version>` GitHub release: queue an EAS production build and automatic TestFlight submission.
3. Test the processed build using the internal TestFlight group.
4. Manually select the validated build in App Store Connect, complete metadata, and submit it for App Review.
5. Choose manual, automatic-after-approval, or phased release in App Store Connect.

EAS Submit sends iOS builds to TestFlight. It does not submit them for public App Store review.

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
6. `EXPO_PUBLIC_API_URL=https://api.navoss.yassin.app` is stored in the EAS `production` environment; keep builds blocked until that endpoint is healthy.
7. Create an Expo access token at <https://expo.dev/settings/access-tokens>.
8. In GitHub, create an `app-store-production` environment and add `EXPO_TOKEN` as an environment secret. Add protection rules before other maintainers receive release access.
9. Run the `iOS TestFlight` workflow manually once before relying on GitHub release triggers.

Apple credentials belong in EAS credential storage or App Store Connect, not in the repository or normal GitHub Actions secrets. Never commit `.p8`, provisioning profile, certificate, Expo token, or Apple password files.

## Release Procedure

1. Update `expo.version` in `apps/mobile/app.json`. EAS remotely increments the iOS build number.
2. Merge only after CI passes.
3. Create a GitHub release with the exact tag `ios-v<expo.version>`, such as `ios-v0.1.0`.
4. Watch the GitHub workflow until EAS accepts the build request, then monitor the EAS build/submission dashboard.
5. Wait for App Store Connect processing and complete export-compliance prompts.
6. Install from TestFlight with Metro disconnected and run the release smoke suite.
7. Promote the tested build manually for external TestFlight or App Review.

The workflow rejects a tag that does not match `apps/mobile/app.json`.

## Over-the-Air Updates

EAS Update is intentionally not enabled yet. It can deliver compatible JavaScript and asset changes without a new binary, but it cannot change native code and it must comply with Apple policy. Automatic production OTA updates are too risky for an early navigation app.

When enabled later, use preview/staging channels first, runtime-version compatibility, an explicit promotion step, and rollback evidence. Do not publish safety-critical navigation changes directly from every merge.
