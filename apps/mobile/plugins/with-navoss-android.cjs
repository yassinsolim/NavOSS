const {
  AndroidConfig,
  withAndroidManifest,
  withGradleProperties,
} = require('@expo/config-plugins');

// The only ABI NavOSS ships for Android (the Retroid Pocket Flip 2 and current phones are
// arm64). Building one ABI instead of React Native's four also quarters native build time.
const ARCHITECTURES = 'arm64-v8a';

/** Set or replace one `gradle.properties` entry. */
function setGradleProperty(properties, key, value) {
  const existing = properties.find((item) => item.type === 'property' && item.key === key);
  if (existing === undefined) {
    properties.push({ key, type: 'property', value });
  } else {
    existing.value = value;
  }
  return properties;
}

/**
 * Release traffic is HTTPS only. The generated debug manifest still allows cleartext (it replaces
 * this attribute) so a Debug build can load JavaScript from Metro over the local network.
 */
function withNoCleartextTraffic(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:usesCleartextTraffic'] = 'false';
  return manifest;
}

/**
 * The development client's floating menu button covers the map's top-right controls; iOS hides it
 * through the same `EXDevMenuShowFloatingActionButton` key in Info.plist. The menu stays reachable
 * with a shake or `adb shell input keyevent 82`.
 */
function withoutDevMenuButton(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    'EXDevMenuShowFloatingActionButton',
    'false',
  );
  return manifest;
}

function withNavOSSAndroid(config) {
  config = withGradleProperties(config, (modConfig) => {
    setGradleProperty(modConfig.modResults, 'reactNativeArchitectures', ARCHITECTURES);
    return modConfig;
  });
  config = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = withoutDevMenuButton(withNoCleartextTraffic(modConfig.modResults));
    return modConfig;
  });
  return config;
}

module.exports = withNavOSSAndroid;
module.exports.ARCHITECTURES = ARCHITECTURES;
module.exports.setGradleProperty = setGradleProperty;
module.exports.withNoCleartextTraffic = withNoCleartextTraffic;
module.exports.withoutDevMenuButton = withoutDevMenuButton;
