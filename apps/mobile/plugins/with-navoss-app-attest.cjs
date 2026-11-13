const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

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
  return config;
}

module.exports = withNavOSSAppAttest;
module.exports.appAttestEnvironment = appAttestEnvironment;
module.exports.developmentTeamId = developmentTeamId;
module.exports.ENTITLEMENT = ENTITLEMENT;
