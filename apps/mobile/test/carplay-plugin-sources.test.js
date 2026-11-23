import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applySceneManifest,
  deferReactNativeStartToScene,
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

// The Expo SDK 57 AppDelegate as `expo prebuild` generated it (unchanged by any NavOSS plugin).
const templateAppDelegate = readFileSync(
  resolve(import.meta.dirname, 'fixtures', 'expo-57-app-delegate.swift'),
  'utf8',
);

// Without CarPlay, the phone scene starts React Native so that the URL that opened the app is in
// its launch options; the development client decides there whether to reopen the last server.
describe('deferred React Native start', () => {
  it('removes the template start so only the phone scene starts React Native', () => {
    const deferred = deferReactNativeStartToScene(templateAppDelegate);
    expect(deferred).not.toContain('startReactNative');
    expect(deferred).not.toContain('UIWindow(frame:');
    expect(deferred).toContain('reactNativeFactory = factory');
    expect(deferred).toContain(
      'return super.application(application, didFinishLaunchingWithOptions',
    );
  });

  it('is idempotent', () => {
    const deferred = deferReactNativeStartToScene(templateAppDelegate);
    expect(deferReactNativeStartToScene(deferred)).toBe(deferred);
  });

  it('fails loudly when the template start changes', () => {
    expect(() =>
      deferReactNativeStartToScene(templateAppDelegate.replace('withModuleName', 'moduleName')),
    ).toThrow(/React Native start/);
  });
});
