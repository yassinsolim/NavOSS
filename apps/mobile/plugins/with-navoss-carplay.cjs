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
const vehicleCarSource = path.join(__dirname, '..', 'assets', 'images', 'vehicle-car.png');
const sourceFiles = [
  'NavOSSCarPlayMapViewController.swift',
  'NavOSSCarPlayDashboardSceneDelegate.swift',
  'NavOSSCarPlaySceneDelegate.swift',
  'NavOSSCarPlayVoiceSearchCoordinator.swift',
  'NavOSSCarPlayVisualHarnessViewController.swift',
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
    const backgroundModes = new Set([
      ...(modConfig.modResults.UIBackgroundModes ?? []),
      'location',
    ]);
    if (carPlayEnabled) {
      modConfig.modResults.NSMicrophoneUsageDescription =
        'NavOSS uses your microphone only when you press the CarPlay voice search button. Audio is recognized on this device and is not retained.';
      modConfig.modResults.NSSpeechRecognitionUsageDescription =
        'NavOSS recognizes a CarPlay destination on this device only after you press the voice search button. Audio and transcripts are not retained.';
      backgroundModes.add('audio');
    } else {
      delete modConfig.modResults.NSMicrophoneUsageDescription;
      delete modConfig.modResults.NSSpeechRecognitionUsageDescription;
      backgroundModes.delete('audio');
    }
    modConfig.modResults.UIBackgroundModes = [...backgroundModes];

    const manifest = modConfig.modResults.UIApplicationSceneManifest ?? {};
    const configurations = manifest.UISceneConfigurations ?? {};
    if (!carPlayEnabled) {
      delete manifest.CPSupportsDashboardNavigationScene;
      delete configurations.CPTemplateApplicationSceneSessionRoleApplication;
      delete configurations.CPTemplateApplicationDashboardSceneSessionRoleApplication;
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
    configurations.CPTemplateApplicationDashboardSceneSessionRoleApplication = [
      {
        UISceneClassName: 'CPTemplateApplicationDashboardScene',
        UISceneConfigurationName: 'NavOSS CarPlay Dashboard',
        UISceneDelegateClassName: 'NavOSSCarPlayDashboardSceneDelegate',
      },
    ];
    manifest.CPSupportsDashboardNavigationScene = true;
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
    // `getProjectName` infers the name by probing for an AppDelegate, which does not exist yet
    // during `expo prebuild --clean`. The mod request already carries the name, so use it and keep
    // the probe only as a fallback for older mod shapes.
    const projectName =
      modConfig.modRequest.projectName ??
      IOSConfig.XcodeUtils.getProjectName(modConfig.modRequest.platformProjectRoot);
    IOSConfig.XcodeUtils.addFramework({
      project: modConfig.modResults,
      projectName,
      framework: 'Speech.framework',
    });
    const resourceDirectory = path.join(modConfig.modRequest.platformProjectRoot, 'Resources');
    const resourcePath = path.join(resourceDirectory, 'vehicle-arrow.png');
    const carResourcePath = path.join(resourceDirectory, 'vehicle-car.png');
    fs.mkdirSync(resourceDirectory, { recursive: true });
    fs.copyFileSync(vehicleArrowSource, resourcePath);
    fs.copyFileSync(vehicleCarSource, carResourcePath);
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
    if (!modConfig.modResults.hasFile('Resources/vehicle-car.png')) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: 'Resources/vehicle-car.png',
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
module.exports.sourceFiles = sourceFiles;
