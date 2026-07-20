const fs = require('node:fs');
const path = require('node:path');
const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');
const { withBuildSourceFile } = require('@expo/config-plugins/build/ios/XcodeProjectFile');

const sourceDirectory = path.join(__dirname, '..', 'carplay', 'ios');
const sourceFiles = ['NavOSSCarPlayMapViewController.swift', 'NavOSSCarPlaySceneDelegate.swift'];

function withNavOSSCarPlay(config) {
  if (process.env.NAVOSS_CARPLAY_ENABLED !== '1') {
    return config;
  }

  for (const filePath of sourceFiles) {
    config = withBuildSourceFile(config, {
      contents: fs.readFileSync(path.join(sourceDirectory, filePath), 'utf8'),
      filePath,
      overwrite: true,
    });
  }

  config = withInfoPlist(config, (modConfig) => {
    const manifest = modConfig.modResults.UIApplicationSceneManifest ?? {};
    const configurations = manifest.UISceneConfigurations ?? {};
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

  if (process.env.NAVOSS_CARPLAY_ENTITLEMENT_ENABLED === '1') {
    config = withEntitlementsPlist(config, (modConfig) => {
      modConfig.modResults['com.apple.developer.carplay-maps'] = true;
      return modConfig;
    });
  }

  return config;
}

module.exports = withNavOSSCarPlay;
