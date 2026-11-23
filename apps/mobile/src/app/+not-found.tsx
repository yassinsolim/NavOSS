import { Redirect, Unmatched } from 'expo-router';

import { IS_ANDROID } from '@/lib/device-copy';

/**
 * A `navoss://` link to a path the app does not have. NavOSS has one screen, so the Android build
 * opens the map rather than Expo Router's developer "Unmatched Route" page; iOS keeps the router's
 * own page, as before.
 */
export default function NotFound() {
  return IS_ANDROID ? <Redirect href="/" /> : <Unmatched />;
}
