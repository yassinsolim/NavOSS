/**
 * Platform facts that decide copy and which features are offered. Pure: the Expo bundler inlines
 * `process.env.EXPO_OS` (`ios` or `android`), so the pure feature modules can use it without
 * importing React Native, and tests (no bundler) read as the iOS build.
 */
const expoOs: unknown = process.env.EXPO_OS;

/** True in the Android build. */
export const IS_ANDROID = expoOs === 'android';

/**
 * How copy names the device NavOSS runs on: the iOS build is iPhone-only; Android runs on
 * phones, tablets and handhelds, so it says "device" ("Saved privately on this device").
 */
export const DEVICE_NOUN = IS_ANDROID ? 'device' : 'iPhone';
