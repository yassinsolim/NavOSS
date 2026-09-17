import { describe, expect, it } from 'vitest';

import {
  MINIMUM_DEPLOYMENT_TARGET,
  withNormalizedPodDeploymentTargets,
} from '../plugins/with-navoss-deployment-target.cjs';

const podfile = [
  "platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'",
  '',
  'target "NavOSS" do',
  '  post_install do |installer|',
  '    react_native_post_install(',
  '      installer,',
  '      config[:reactNativePath],',
  '    )',
  '  end',
  'end',
  '',
].join('\n');

describe('pod deployment target normalization', () => {
  it('appends the normalizer as the last statement of post_install', () => {
    const patched = withNormalizedPodDeploymentTargets(podfile).split('\n');
    const normalizerIndex = patched.findIndex((line) =>
      line.includes("build_settings['IPHONEOS_DEPLOYMENT_TARGET']"),
    );
    const reactNativeIndex = patched.findIndex((line) =>
      line.includes('react_native_post_install('),
    );

    // Ordering is the contract: react_native_post_install lowers targets back under the floor if
    // it runs afterwards, which is exactly how the Xcode 27 build broke.
    expect(normalizerIndex).toBeGreaterThan(reactNativeIndex);
    expect(patched.at(-3)).toContain('end');
    expect(patched.join('\n')).toContain(MINIMUM_DEPLOYMENT_TARGET);
  });

  it('stays inside the existing block rather than declaring a second post_install', () => {
    const patched = withNormalizedPodDeploymentTargets(podfile);

    // CocoaPods keeps only the last post_install hook, so a second block would silently drop
    // react_native_post_install and break the build in a far more confusing way.
    expect(patched.match(/post_install do \|installer\|/g)).toHaveLength(1);
  });

  it('is idempotent so repeated prebuilds do not stack copies', () => {
    const once = withNormalizedPodDeploymentTargets(podfile);

    expect(withNormalizedPodDeploymentTargets(once)).toBe(once);
  });

  it('refuses a Podfile with no post_install block instead of silently doing nothing', () => {
    expect(() => withNormalizedPodDeploymentTargets('platform :ios, 16.4\n')).toThrow(
      /no post_install/,
    );
  });
});
