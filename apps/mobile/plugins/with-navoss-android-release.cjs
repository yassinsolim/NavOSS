const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
} = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const { setGradleProperty } = require('./with-navoss-android.cjs');

/**
 * Android release build: signing with the NavOSS release key, a build-time version code, R8 and
 * resource shrinking. Everything lands in the generated (git-ignored) `android/` project.
 *
 * Signing reads three environment variables at Gradle time, never at prebuild time, so no secret
 * is written into a generated file:
 * - `NAVOSS_ANDROID_KEYSTORE`: path to the PKCS12 keystore
 * - `NAVOSS_ANDROID_KEYSTORE_PASSWORD`: store password (also the key password)
 * - `NAVOSS_ANDROID_KEY_ALIAS`: key alias
 * A release task requested without all three fails the build; it never falls back to the debug key.
 */

const SIGNING_MARKER_START = '// @generated begin navoss-release-signing';
const SIGNING_MARKER_END = '// @generated end navoss-release-signing';

const SIGNING_BLOCK = `${SIGNING_MARKER_START} (plugins/with-navoss-android-release.cjs)
def navossKeystore = System.getenv('NAVOSS_ANDROID_KEYSTORE')
def navossKeystorePassword = System.getenv('NAVOSS_ANDROID_KEYSTORE_PASSWORD')
def navossKeyAlias = System.getenv('NAVOSS_ANDROID_KEY_ALIAS')
def navossSigningReady = [navossKeystore, navossKeystorePassword, navossKeyAlias].every { it != null && !it.isEmpty() }

android {
    signingConfigs {
        navossRelease {
            if (navossSigningReady) {
                storeFile file(navossKeystore)
                storeType 'pkcs12'
                storePassword navossKeystorePassword
                keyAlias navossKeyAlias
                keyPassword navossKeystorePassword
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.navossRelease
        }
    }
}

gradle.taskGraph.whenReady { graph ->
    def releaseTask = graph.allTasks.find { it.project == project && it.name.toLowerCase().contains('release') && (it.name.startsWith('assemble') || it.name.startsWith('bundle') || it.name.startsWith('package') || it.name.startsWith('sign')) }
    if (releaseTask != null && !navossSigningReady) {
        throw new GradleException("NavOSS release builds must be signed with the release key. Set NAVOSS_ANDROID_KEYSTORE, NAVOSS_ANDROID_KEYSTORE_PASSWORD and NAVOSS_ANDROID_KEY_ALIAS (requested: \${releaseTask.name}).")
    }
    if (releaseTask != null && !file(navossKeystore).isFile()) {
        throw new GradleException("NAVOSS_ANDROID_KEYSTORE does not point to a file.")
    }
}
${SIGNING_MARKER_END}`;

/** Android rejects a version code outside 1…2100000000. */
const MAX_VERSION_CODE = 2_100_000_000;

/**
 * The version code for this build: `NAVOSS_ANDROID_VERSION_CODE` when set (the release workflow
 * sets it from its run number), otherwise `expo.android.versionCode` from app.json.
 */
function resolveVersionCode(env, fallback) {
  const raw = env.NAVOSS_ANDROID_VERSION_CODE;
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`NAVOSS_ANDROID_VERSION_CODE must be a positive integer, received "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_VERSION_CODE) {
    throw new Error(`NAVOSS_ANDROID_VERSION_CODE must be between 1 and ${MAX_VERSION_CODE}.`);
  }
  return value;
}

/** Writes `versionCode` / `versionName` into the generated `defaultConfig`. */
function setVersion(buildGradle, versionCode, versionName) {
  if (!/versionCode \d+/.test(buildGradle) || !/versionName "[^"]*"/.test(buildGradle)) {
    throw new Error('app/build.gradle has no versionCode / versionName to replace.');
  }
  return buildGradle
    .replace(/versionCode \d+/, `versionCode ${String(versionCode)}`)
    .replace(/versionName "[^"]*"/, `versionName "${versionName}"`);
}

/** Appends the signing block once; a second prebuild replaces it instead of duplicating it. */
function addReleaseSigning(buildGradle) {
  const start = buildGradle.indexOf(SIGNING_MARKER_START);
  if (start !== -1) {
    const end = buildGradle.indexOf(SIGNING_MARKER_END, start);
    buildGradle =
      buildGradle.slice(0, start).trimEnd() +
      buildGradle.slice(end + SIGNING_MARKER_END.length).trimEnd();
  }
  return `${buildGradle.trimEnd()}\n\n${SIGNING_BLOCK}\n`;
}

/**
 * Test builds only: `EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL` points the updater at a fake release
 * endpoint on the device's loopback (reached through `adb reverse`). Cleartext is then allowed for
 * 127.0.0.1 alone. The updater refuses every other host outside GitHub, so any other value fails
 * the build here. The release workflow refuses to build with the variable set.
 */
function testFeedOrigin(env) {
  const raw = env.EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL;
  if (raw === undefined || raw === '') return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL must be http://127.0.0.1:<port>/….');
  }
  return url.hostname;
}

const TEST_NETWORK_CONFIG = 'navoss_update_test_network';

function testNetworkSecurityConfig(host) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Test build only (EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL): the fake release endpoint. -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">${host}</domain>
  </domain-config>
</network-security-config>
`;
}

function withNavOSSAndroidRelease(config) {
  const env = process.env;
  const versionCode = resolveVersionCode(env, config.android?.versionCode ?? 1);
  const versionName = config.version ?? '0.0.0';
  const testHost = testFeedOrigin(env);

  config = withGradleProperties(config, (modConfig) => {
    // R8 and resource shrinking; proguard rules ship with React Native, Expo and the libraries.
    setGradleProperty(modConfig.modResults, 'android.enableMinifyInReleaseBuilds', 'true');
    setGradleProperty(modConfig.modResults, 'android.enableShrinkResourcesInReleaseBuilds', 'true');
    return modConfig;
  });
  config = withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = addReleaseSigning(
      setVersion(modConfig.modResults.contents, versionCode, versionName),
    );
    return modConfig;
  });
  if (testHost !== undefined) {
    config = withDangerousMod(config, [
      'android',
      (modConfig) => {
        const directory = path.join(
          modConfig.modRequest.platformProjectRoot,
          'app/src/main/res/xml',
        );
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, `${TEST_NETWORK_CONFIG}.xml`),
          testNetworkSecurityConfig(testHost),
        );
        return modConfig;
      },
    ]);
    config = withAndroidManifest(config, (modConfig) => {
      const application = AndroidConfig.Manifest.getMainApplicationOrThrow(modConfig.modResults);
      application.$['android:networkSecurityConfig'] = `@xml/${TEST_NETWORK_CONFIG}`;
      return modConfig;
    });
  }
  return config;
}

module.exports = withNavOSSAndroidRelease;
module.exports.addReleaseSigning = addReleaseSigning;
module.exports.resolveVersionCode = resolveVersionCode;
module.exports.setVersion = setVersion;
module.exports.testFeedOrigin = testFeedOrigin;
