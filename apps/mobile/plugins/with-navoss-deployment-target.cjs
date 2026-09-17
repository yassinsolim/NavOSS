const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

// Xcode 27 refuses to build a target whose deployment target is below iOS 15.0. Dependencies pin
// their own floors -- RNCAsyncStorage still declares 13.4 -- so a toolchain upgrade breaks the
// simulator build with "The iOS deployment target is set to 13.4, but the range of supported
// deployment target versions is 15.0 to 27.0". CocoaPods keeps only the last `post_install` hook,
// so this appends inside the generated one rather than declaring a second block.
const MINIMUM_DEPLOYMENT_TARGET = '16.4';

const NORMALIZE_SNIPPET = `    installer.pods_project.targets.each do |pod_target|
      pod_target.build_configurations.each do |pod_config|
        current = pod_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current && Gem::Version.new(current) < Gem::Version.new('${MINIMUM_DEPLOYMENT_TARGET}')
          pod_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MINIMUM_DEPLOYMENT_TARGET}'
        end
      end
    end`;

/** Append the normalizer as the final statement of the generated `post_install` block. */
function withNormalizedPodDeploymentTargets(podfile) {
  if (podfile.includes('IPHONEOS_DEPLOYMENT_TARGET')) return podfile;
  const lines = podfile.split('\n');
  const openIndex = lines.findIndex((line) => /^\s*post_install do \|installer\|\s*$/.test(line));
  if (openIndex === -1) {
    throw new Error('Generated Podfile has no post_install block to normalize.');
  }
  const indent = (/^(\s*)/.exec(lines[openIndex]) ?? ['', ''])[1];
  // Run last so react_native_post_install cannot lower a target back under the floor.
  const closeIndex = lines.findIndex((line, index) => index > openIndex && line === `${indent}end`);
  if (closeIndex === -1) {
    throw new Error('Generated Podfile post_install block is not terminated.');
  }
  lines.splice(closeIndex, 0, NORMALIZE_SNIPPET);
  return lines.join('\n');
}

const withNavOssDeploymentTarget = (config) =>
  withDangerousMod(config, [
    'ios',
    (dangerousConfig) => {
      const podfilePath = path.join(dangerousConfig.modRequest.platformProjectRoot, 'Podfile');
      const podfile = fs.readFileSync(podfilePath, 'utf8');
      fs.writeFileSync(podfilePath, withNormalizedPodDeploymentTargets(podfile));
      return dangerousConfig;
    },
  ]);

module.exports = withNavOssDeploymentTarget;
module.exports.withNormalizedPodDeploymentTargets = withNormalizedPodDeploymentTargets;
module.exports.MINIMUM_DEPLOYMENT_TARGET = MINIMUM_DEPLOYMENT_TARGET;
