import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface AccessedApi {
  NSPrivacyAccessedAPIType: string;
  NSPrivacyAccessedAPITypeReasons: string[];
}

const appJson = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
  expo: { ios: { privacyManifests: { NSPrivacyAccessedAPITypes: AccessedApi[] } } };
};
const accessed = appJson.expo.ios.privacyManifests.NSPrivacyAccessedAPITypes;
const reasons = (category: string) =>
  accessed.find((entry) => entry.NSPrivacyAccessedAPIType === category)
    ?.NSPrivacyAccessedAPITypeReasons;

// Apple "Describing use of required reason API" (checked 2026-11-12):
// E174.1 check for enough space before writing files / skip a download when there is not;
// 85F4.1 display disk space to the person using the device; C617.1 metadata of files inside
// the app container; 35F9.1 measure elapsed time between in-app events.
describe('privacy manifest', () => {
  it('declares disk space for offline downloads and the storage line', () => {
    // NavOSSOfflineStore reads volumeAvailableCapacityForImportantUsageKey to refuse a download
    // that cannot fit and to show free space on the Offline maps screen.
    expect(reasons('NSPrivacyAccessedAPICategoryDiskSpace')).toEqual(['E174.1', '85F4.1']);
  });

  it('declares the file metadata and boot-time APIs the offline engine and store use', () => {
    // The store reads sizes of its own staged files; the statically linked Valhalla engine
    // calls stat/lstat on its tiles and tzdata and mach_absolute_time for timing, and ships no
    // privacy manifest of its own.
    expect(reasons('NSPrivacyAccessedAPICategoryFileTimestamp')).toEqual(['C617.1']);
    expect(reasons('NSPrivacyAccessedAPICategorySystemBootTime')).toEqual(['35F9.1']);
    expect(reasons('NSPrivacyAccessedAPICategoryUserDefaults')).toEqual(['CA92.1']);
  });
});
