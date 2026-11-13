import { describe, expect, it } from 'vitest';

import { appAttestEnvironment, developmentTeamId } from '../plugins/with-navoss-app-attest.cjs';

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
});
