import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appAttestEnvironment,
  developmentTeamId,
  RELEASE_GUARD_SCRIPT,
} from '../plugins/with-navoss-app-attest.cjs';

function runGuard(configuration, environment) {
  const directory = mkdtempSync(join(tmpdir(), 'navoss-attest-'));
  writeFileSync(
    join(directory, 'NavOSS.entitlements'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.developer.devicecheck.appattest-environment</key><string>${environment}</string></dict></plist>`,
  );
  return spawnSync('/bin/sh', ['-c', RELEASE_GUARD_SCRIPT], {
    encoding: 'utf8',
    env: {
      CODE_SIGN_ENTITLEMENTS: 'NavOSS.entitlements',
      CONFIGURATION: configuration,
      SRCROOT: directory,
    },
  });
}

describe('App Attest entitlement environment', () => {
  it('is production for every distribution EAS profile', () => {
    for (const profile of [
      'production',
      'production-carplay',
      'production-carplay-google',
      'internal-carplay',
      'preview',
    ]) {
      expect(appAttestEnvironment({ EAS_BUILD_PROFILE: profile })).toBe('production');
    }
  });

  it('is development for the development profile and local builds', () => {
    expect(appAttestEnvironment({ EAS_BUILD_PROFILE: 'development' })).toBe('development');
    expect(appAttestEnvironment({})).toBe('development');
  });

  it('refuses a development environment on a distribution build', () => {
    expect(() =>
      appAttestEnvironment({
        EAS_BUILD_PROFILE: 'production-carplay',
        NAVOSS_APP_ATTEST_ENVIRONMENT: 'development',
      }),
    ).toThrow(/must be production/);
    expect(() => appAttestEnvironment({ NAVOSS_APP_ATTEST_ENVIRONMENT: 'staging' })).toThrow();
  });

  it('honours an explicit production environment for a local release archive', () => {
    expect(appAttestEnvironment({ NAVOSS_APP_ATTEST_ENVIRONMENT: 'production' })).toBe(
      'production',
    );
  });

  it('validates the development team id used by the simulator software key', () => {
    expect(developmentTeamId({ NAVOSS_DEVELOPMENT_APP_ATTEST_TEAM_ID: 'ABCDE12345' })).toBe(
      'ABCDE12345',
    );
    expect(developmentTeamId({})).toBeUndefined();
    expect(() => developmentTeamId({ NAVOSS_DEVELOPMENT_APP_ATTEST_TEAM_ID: 'abc' })).toThrow();
  });

  it.skipIf(process.platform !== 'darwin')(
    'fails a Release build that would ship the development environment',
    () => {
      expect(runGuard('Release', 'development').status).toBe(1);
      expect(runGuard('Release', 'production').status).toBe(0);
      expect(runGuard('Debug', 'development').status).toBe(0);
    },
  );
});
