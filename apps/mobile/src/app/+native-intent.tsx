import { IS_ANDROID } from '@/lib/device-copy';

/**
 * Every system link (`navoss://…`) passes through here before Expo Router matches it. NavOSS has
 * one screen, so the Android build opens the map for any path rather than Expo Router's developer
 * "Unmatched Route" page. iOS passes the link through untouched and keeps the router's own
 * handling, as before.
 */
export function redirectSystemPath({ path }: { initial: boolean; path: string }): string {
  return IS_ANDROID ? '/' : path;
}
