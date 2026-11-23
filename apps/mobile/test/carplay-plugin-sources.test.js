import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applySceneManifest,
  phoneSourceFiles,
  sourceFiles,
} = require('../plugins/with-navoss-carplay.cjs');

const phoneScene = {
  UISceneClassName: 'UIWindowScene',
  UISceneConfigurationName: 'NavOSS Phone',
  UISceneDelegateClassName: 'NavOSSPhoneSceneDelegate',
};

describe('CarPlay config plugin sources', () => {
  // A Swift file under carplay/ios that the plugin does not copy never reaches the app target, so
  // its types silently vanish from CarPlay builds (or the build fails far from the cause).
  it('copies every CarPlay Swift source and nothing that does not exist', () => {
    const onDisk = readdirSync(resolve(import.meta.dirname, '..', 'carplay', 'ios'))
      .filter((name) => name.endsWith('.swift'))
      .sort();
    expect([...sourceFiles].sort()).toEqual(onDisk);
  });

  it('copies the phone scene delegate into builds without CarPlay', () => {
    expect(phoneSourceFiles).toEqual(['NavOSSPhoneSceneDelegate.swift']);
  });
});

// Apps linked against the iOS 27 SDK that declare no window scene are stopped by UIKit at launch.
describe('scene manifest', () => {
  it('declares the phone window scene alone when CarPlay is disabled', () => {
    expect(applySceneManifest({}, false).UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [phoneScene] },
    });
  });

  it('declares the phone, CarPlay, Dashboard and instrument cluster scenes in one manifest', () => {
    const manifest = applySceneManifest({}, true).UIApplicationSceneManifest;
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(true);
    expect(manifest.CPSupportsDashboardNavigationScene).toBe(true);
    expect(manifest.CPSupportsInstrumentClusterNavigationScene).toBe(true);
    const configurations = manifest.UISceneConfigurations;
    expect(configurations.UIWindowSceneSessionRoleApplication).toEqual([phoneScene]);
    expect(
      Object.fromEntries(
        Object.entries(configurations).map(([role, [scene]]) => [
          role,
          scene.UISceneDelegateClassName,
        ]),
      ),
    ).toEqual({
      CPTemplateApplicationDashboardSceneSessionRoleApplication:
        'NavOSSCarPlayDashboardSceneDelegate',
      CPTemplateApplicationInstrumentClusterSceneSessionRoleApplication:
        'NavOSSCarPlayInstrumentClusterSceneDelegate',
      CPTemplateApplicationSceneSessionRoleApplication: 'NavOSSCarPlaySceneDelegate',
      UIWindowSceneSessionRoleApplication: 'NavOSSPhoneSceneDelegate',
    });
  });

  it('removes CarPlay scenes but keeps the phone scene when CarPlay is turned off', () => {
    const carPlay = applySceneManifest({}, true);
    expect(applySceneManifest(carPlay, false).UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [phoneScene] },
    });
  });
});
