const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

const SERVICE_NAME = 'org.navoss.mobile.navigation.NavigationForegroundService';

/**
 * What turn-by-turn guidance needs from the manifest: a `location` foreground service that keeps
 * a trip running with the screen off, the permissions to start it, and the notification it shows.
 * The service is started only while the app is visible, so there is no background-location
 * permission.
 */
const PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
];

/** Add each permission once, keeping any already declared. */
function withNavigationPermissions(manifest) {
  const declared = (manifest.manifest['uses-permission'] ??= []);
  for (const name of PERMISSIONS) {
    if (!declared.some((item) => item.$['android:name'] === name)) {
      declared.push({ $: { 'android:name': name } });
    }
  }
  return manifest;
}

/** Declare the navigation service once, replacing an earlier declaration of it. */
function withNavigationService(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const services = (application.service ??= []);
  const service = {
    $: {
      'android:name': SERVICE_NAME,
      'android:exported': 'false',
      'android:foregroundServiceType': 'location',
    },
  };
  const index = services.findIndex((item) => item.$['android:name'] === SERVICE_NAME);
  if (index === -1) {
    services.push(service);
  } else {
    services[index] = service;
  }
  return manifest;
}

function withNavOSSAndroidNavigation(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = withNavigationService(withNavigationPermissions(modConfig.modResults));
    return modConfig;
  });
}

module.exports = withNavOSSAndroidNavigation;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.withNavigationPermissions = withNavigationPermissions;
module.exports.withNavigationService = withNavigationService;
