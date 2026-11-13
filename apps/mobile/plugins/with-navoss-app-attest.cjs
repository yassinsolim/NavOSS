const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

// App Attest for community reports and traffic credentials. Apple issues keys in the
// environment named by this entitlement, and the API checks the matching AAGUID
// (APP_ATTEST_ENVIRONMENT), so TestFlight/App Store builds must say `production` and local
// development builds `development`. EAS also enables the App Attest capability on the App ID
// from this entitlement when it syncs capabilities.
const ENTITLEMENT = 'com.apple.developer.devicecheck.appattest-environment';
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
  const environment = appAttestEnvironment();
  const teamId = environment === 'development' ? developmentTeamId() : undefined;
  config = withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults[ENTITLEMENT] = environment;
    return modConfig;
  });
  config = withInfoPlist(config, (modConfig) => {
    if (teamId === undefined) {
      delete modConfig.modResults[DEVELOPMENT_TEAM_ID_KEY];
    } else {
      modConfig.modResults[DEVELOPMENT_TEAM_ID_KEY] = teamId;
    }
    return modConfig;
  });
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
module.exports.developmentTeamId = developmentTeamId;
module.exports.ENTITLEMENT = ENTITLEMENT;
