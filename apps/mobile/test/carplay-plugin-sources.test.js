import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applyReactNativeStart,
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

// The Expo SDK 57 AppDelegate as `expo prebuild` generated it (unchanged by any NavOSS plugin).
const templateAppDelegate = readFileSync(
  resolve(import.meta.dirname, 'fixtures', 'expo-57-app-delegate.swift'),
  'utf8',
);

// Without CarPlay, the phone scene starts React Native so that the URL that opened the app is in
// its launch options. A CarPlay build must always keep the template start, including after
// `expo prebuild --no-clean` switches flavours.
describe('React Native start in AppDelegate', () => {
  const deferred = applyReactNativeStart(templateAppDelegate, false);

  it('off -> off: removes the template start, then leaves it removed', () => {
    expect(deferred).not.toContain('startReactNative');
    expect(deferred).not.toContain('UIWindow(frame:');
    expect(deferred).toContain('reactNativeFactory = factory');
    expect(deferred).toContain(
      'return super.application(application, didFinishLaunchingWithOptions',
    );
    expect(applyReactNativeStart(deferred, false)).toBe(deferred);
  });

  it('off -> on: restores the template byte for byte', () => {
    expect(applyReactNativeStart(deferred, true)).toBe(templateAppDelegate);
  });

  it('on -> off: removes the start again', () => {
    expect(applyReactNativeStart(applyReactNativeStart(deferred, true), false)).toBe(deferred);
  });

  it('on -> on: leaves the template untouched', () => {
    expect(applyReactNativeStart(templateAppDelegate, true)).toBe(templateAppDelegate);
  });

  it('fails loudly when neither the template start nor the marker is present', () => {
    const changed = templateAppDelegate.replace('withModuleName', 'moduleName');
    expect(() => applyReactNativeStart(changed, false)).toThrow(/React Native start/);
    expect(() => applyReactNativeStart(changed, true)).toThrow(/React Native start/);
  });
});
