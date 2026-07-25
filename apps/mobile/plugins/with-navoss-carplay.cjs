const fs = require('node:fs');
const path = require('node:path');
const {
  IOSConfig,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('@expo/config-plugins');
const { withBuildSourceFile } = require('@expo/config-plugins/build/ios/XcodeProjectFile');

const sourceDirectory = path.join(__dirname, '..', 'carplay', 'ios');
const vehicleArrowSource = path.join(__dirname, '..', 'assets', 'images', 'vehicle-arrow.png');
const sourceFiles = [
  'NavOSSCarPlayMapViewController.swift',
  'NavOSSCarPlaySceneDelegate.swift',
  'NavOSSPhoneSceneDelegate.swift',
];

function configuredApiUrl() {
  const value = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error('EXPO_PUBLIC_API_URL is required for an iOS navigation build.');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('iOS navigation builds require an HTTPS API URL outside local development.');
  }
  return url.toString();
}

function googlePlacesBuildConfiguration(environment = process.env) {
  const enabled = environment.NAVOSS_GOOGLE_PLACES_ENABLED === '1';
  const apiKey = environment.GOOGLE_PLACES_IOS_API_KEY?.trim();
  if (enabled && (apiKey === undefined || apiKey.length === 0)) {
    throw new Error('GOOGLE_PLACES_IOS_API_KEY is required when NAVOSS_GOOGLE_PLACES_ENABLED=1.');
  }
  return { enabled, ...(enabled ? { apiKey } : {}) };
}

function withNavOSSCarPlay(config) {
  const carPlayEnabled = process.env.NAVOSS_CARPLAY_ENABLED === '1';
  const googlePlaces = googlePlacesBuildConfiguration();

  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults.NavOSSAPIURL = configuredApiUrl();
    if (googlePlaces.enabled) {
      modConfig.modResults.NavOSSGooglePlacesEnabled = true;
      modConfig.modResults.NavOSSGooglePlacesAPIKey = googlePlaces.apiKey;
    } else {
      delete modConfig.modResults.NavOSSGooglePlacesEnabled;
      delete modConfig.modResults.NavOSSGooglePlacesAPIKey;
    }
    modConfig.modResults.UIBackgroundModes = [
      ...new Set([...(modConfig.modResults.UIBackgroundModes ?? []), 'location']),
    ];

    const manifest = modConfig.modResults.UIApplicationSceneManifest ?? {};
    const configurations = manifest.UISceneConfigurations ?? {};
    if (!carPlayEnabled) {
      delete configurations.CPTemplateApplicationSceneSessionRoleApplication;
      if (manifest.UISceneConfigurations !== undefined) {
        manifest.UISceneConfigurations = configurations;
        modConfig.modResults.UIApplicationSceneManifest = manifest;
      }
      return modConfig;
    }

    configurations.UIWindowSceneSessionRoleApplication ??= [
      {
        UISceneClassName: 'UIWindowScene',
        UISceneConfigurationName: 'NavOSS Phone',
        UISceneDelegateClassName: 'NavOSSPhoneSceneDelegate',
      },
    ];
    configurations.CPTemplateApplicationSceneSessionRoleApplication = [
      {
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneConfigurationName: 'NavOSS CarPlay',
        UISceneDelegateClassName: 'NavOSSCarPlaySceneDelegate',
      },
    ];
    manifest.UIApplicationSupportsMultipleScenes = true;
    manifest.UISceneConfigurations = configurations;
    modConfig.modResults.UIApplicationSceneManifest = manifest;
    return modConfig;
  });

  config = withEntitlementsPlist(config, (modConfig) => {
    if (carPlayEnabled && process.env.NAVOSS_CARPLAY_ENTITLEMENT_ENABLED === '1') {
      modConfig.modResults['com.apple.developer.carplay-maps'] = true;
    } else {
      delete modConfig.modResults['com.apple.developer.carplay-maps'];
    }
    return modConfig;
  });

  if (!carPlayEnabled) {
    return config;
  }

  for (const filePath of sourceFiles) {
    config = withBuildSourceFile(config, {
      contents: fs.readFileSync(path.join(sourceDirectory, filePath), 'utf8'),
      filePath,
      overwrite: true,
    });
  }

  config = withXcodeProject(config, (modConfig) => {
    const resourceDirectory = path.join(modConfig.modRequest.platformProjectRoot, 'Resources');
    const resourcePath = path.join(resourceDirectory, 'vehicle-arrow.png');
    fs.mkdirSync(resourceDirectory, { recursive: true });
    fs.copyFileSync(vehicleArrowSource, resourcePath);
    IOSConfig.XcodeUtils.ensureGroupRecursively(modConfig.modResults, 'Resources');
    if (!modConfig.modResults.hasFile('Resources/vehicle-arrow.png')) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: 'Resources/vehicle-arrow.png',
        groupName: 'Resources',
        isBuildFile: true,
        project: modConfig.modResults,
        verbose: true,
      });
    }
    return modConfig;
  });

  return config;
}

module.exports = withNavOSSCarPlay;
module.exports.googlePlacesBuildConfiguration = googlePlacesBuildConfiguration;
