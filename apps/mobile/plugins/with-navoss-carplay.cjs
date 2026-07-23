const fs = require('node:fs');
const path = require('node:path');
const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');
const { withBuildSourceFile } = require('@expo/config-plugins/build/ios/XcodeProjectFile');

const sourceDirectory = path.join(__dirname, '..', 'carplay', 'ios');
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

function withNavOSSCarPlay(config) {
  const carPlayEnabled = process.env.NAVOSS_CARPLAY_ENABLED === '1';

  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults.NavOSSAPIURL = configuredApiUrl();
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

  return config;
}

module.exports = withNavOSSCarPlay;
