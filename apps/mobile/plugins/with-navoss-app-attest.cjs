const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

// App Attest for community reports and traffic credentials. Apple issues keys in the
// environment named by this entitlement, and the API checks the matching AAGUID
// (APP_ATTEST_ENVIRONMENT), so TestFlight/App Store builds must say `production` and local
// development builds `development`. EAS also enables the App Attest capability on the App ID
// from this entitlement when it syncs capabilities.
const ENTITLEMENT = 'com.apple.developer.devicecheck.appattest-environment';
const ENABLED_INFO_KEY = 'NavOSSAppAttestEnabled';

/**
 * The entitlement is written only with `NAVOSS_APP_ATTEST_ENTITLEMENT_ENABLED=1`, like CarPlay's.
 * A provisioning profile must include the App Attest capability before a signed build may carry
 * it, which is an Apple Developer account change; until then builds ship without it and the app
 * keeps community writes in the "not supported" state.
 */
function appAttestEntitlementEnabled(environment = process.env) {
  return environment.NAVOSS_APP_ATTEST_ENTITLEMENT_ENABLED === '1';
}

/** What the plugin writes for an environment: the entitlement, the Info.plist switch, the guard. */
function appAttestBuildSettings(environment = process.env) {
  const attestEnvironment = appAttestEnvironment(environment);
  const enabled = appAttestEntitlementEnabled(environment);
  return {
    developmentTeamId:
      attestEnvironment === 'development' ? developmentTeamId(environment) : undefined,
    entitlement: enabled ? attestEnvironment : undefined,
    releaseGuard: enabled,
  };
}
const DEVELOPMENT_TEAM_ID_KEY = 'NavOSSDevelopmentAppAttestTeamID';

/**
 * `NAVOSS_APP_ATTEST_ENVIRONMENT` wins when set. Otherwise any EAS profile except `development`
 * is a distribution build (production); a local `expo run:ios` without a profile is development.
 */
function appAttestEnvironment(environment = process.env) {
  const explicit = environment.NAVOSS_APP_ATTEST_ENVIRONMENT?.trim() || undefined;
  const profile = environment.EAS_BUILD_PROFILE?.trim() || undefined;
  const distribution = profile !== undefined && profile !== 'development';
  if (explicit !== undefined && explicit !== 'production' && explicit !== 'development') {
    throw new Error('NAVOSS_APP_ATTEST_ENVIRONMENT must be "production" or "development".');
  }
  if (distribution && explicit === 'development') {
    throw new Error(
      `EAS profile "${profile}" distributes the app; its App Attest environment must be production.`,
    );
  }
  return explicit ?? (distribution ? 'production' : 'development');
}

/**
 * The Simulator has no App Attest; DEBUG builds sign with a software key instead, which only a
 * local API in COMMUNITY_ATTESTATION_MODE=allow-development accepts (as untrusted). Its RP id
 * hash needs that API's APP_ATTEST_TEAM_ID. Never written for a production environment, and the
 * Swift code that reads it is compiled out of Release builds.
 */
function developmentTeamId(environment = process.env) {
  const value = environment.NAVOSS_DEVELOPMENT_APP_ATTEST_TEAM_ID?.trim() || undefined;
  if (value !== undefined && !/^[A-Z0-9]{10}$/.test(value)) {
    throw new Error('NAVOSS_DEVELOPMENT_APP_ATTEST_TEAM_ID must be a 10-character team id.');
  }
  return value;
}

const GUARD_PHASE_NAME = 'NavOSS App Attest environment guard';

/**
 * Fails a Release build whose entitlements do not say `production`, so a local
 * `expo prebuild` (development by default) followed by a Release archive cannot ship a
 * development App Attest environment.
 */
const RELEASE_GUARD_SCRIPT = [
  'if [ "$CONFIGURATION" = "Release" ]; then',
  '  file="$SRCROOT/$CODE_SIGN_ENTITLEMENTS"',
  `  value=$(/usr/libexec/PlistBuddy -c "Print :${ENTITLEMENT}" "$file" 2>/dev/null)`,
  '  if [ "$value" != "production" ]; then',
  '    echo "error: Release builds must use the production App Attest environment; run expo prebuild with NAVOSS_APP_ATTEST_ENVIRONMENT=production."',
  '    exit 1',
  '  fi',
  'fi',
].join('\n');

function withNavOSSAppAttest(config) {
  const settings = appAttestBuildSettings();
  const teamId = settings.developmentTeamId;
  config = withEntitlementsPlist(config, (modConfig) => {
    if (settings.entitlement === undefined) {
      delete modConfig.modResults[ENTITLEMENT];
    } else {
      modConfig.modResults[ENTITLEMENT] = settings.entitlement;
    }
    return modConfig;
  });
  config = withInfoPlist(config, (modConfig) => {
    if (settings.entitlement === undefined) {
      delete modConfig.modResults[ENABLED_INFO_KEY];
    } else {
      modConfig.modResults[ENABLED_INFO_KEY] = true;
    }
    if (teamId === undefined) {
      delete modConfig.modResults[DEVELOPMENT_TEAM_ID_KEY];
    } else {
      modConfig.modResults[DEVELOPMENT_TEAM_ID_KEY] = teamId;
    }
    return modConfig;
  });
  if (!settings.releaseGuard) return config;
  config = withXcodeProject(config, (modConfig) => {
    const project = modConfig.modResults;
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const present = Object.values(phases).some(
      (phase) => typeof phase === 'object' && phase.name === `"${GUARD_PHASE_NAME}"`,
    );
    if (!present) {
      project.addBuildPhase(
        [],
        'PBXShellScriptBuildPhase',
        GUARD_PHASE_NAME,
        project.getFirstTarget().uuid,
        {
          shellPath: '/bin/sh',
          shellScript: RELEASE_GUARD_SCRIPT,
        },
      );
    }
    return modConfig;
  });
  return config;
}

module.exports = withNavOSSAppAttest;
module.exports.RELEASE_GUARD_SCRIPT = RELEASE_GUARD_SCRIPT;
module.exports.appAttestEnvironment = appAttestEnvironment;
module.exports.appAttestBuildSettings = appAttestBuildSettings;
module.exports.appAttestEntitlementEnabled = appAttestEntitlementEnabled;
module.exports.developmentTeamId = developmentTeamId;
module.exports.ENTITLEMENT = ENTITLEMENT;
