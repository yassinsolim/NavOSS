import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GUIDANCE_SETTINGS,
  guidanceSettingsFromNative,
  rerouteDeltaLabel,
  rerouteModeDescription,
  speedReadout,
} from '../src/features/navigation/guidance-settings.js';

describe('speed readout', () => {
  it('shows nothing until the navigation core reports a speed or a limit', () => {
    expect(speedReadout({})).toBeUndefined();
    expect(speedReadout({ speedingState: 'unknown' })).toBeUndefined();
  });

  it('rounds speed to whole km/h and reads it out with the limit', () => {
    expect(
      speedReadout({
        speedLimitKph: 50,
        speedMetersPerSecond: 13.4,
        speedingState: 'within-limit',
      }),
    ).toEqual({
      accessibilityLabel: 'Speed 48 kilometres per hour, limit 50',
      limitKph: 50,
      overLimit: false,
      speedKph: 48,
    });
  });

  it('marks the speed over the limit only when the core says so, never from its own arithmetic', () => {
    // 58 km/h in a 50 with a tolerance the phone does not know: the core's verdict decides.
    const within = speedReadout({
      speedLimitKph: 50,
      speedMetersPerSecond: 16.1,
      speedingState: 'within-limit',
    });
    expect(within?.overLimit).toBe(false);
    const over = speedReadout({
      speedLimitKph: 50,
      speedMetersPerSecond: 16.1,
      speedingState: 'over-limit',
    });
    expect(over?.overLimit).toBe(true);
    expect(over?.accessibilityLabel).toBe('Speed 58 kilometres per hour, limit 50, over the limit');
  });

  it('shows a speed without a limit, and a limit without a speed, but never an invented value', () => {
    expect(speedReadout({ speedMetersPerSecond: 27.8 })).toMatchObject({
      limitKph: undefined,
      speedKph: 100,
    });
    expect(speedReadout({ speedLimitKph: 80 })).toMatchObject({
      limitKph: 80,
      speedKph: undefined,
    });
    expect(speedReadout({ speedLimitKph: 0, speedMetersPerSecond: -1 })).toBeUndefined();
    expect(speedReadout({ speedLimitKph: 80, speedingState: 'over-limit' })?.overLimit).toBe(false);
  });
});

describe('reroute offer', () => {
  it('states what the new route costs or saves against the chosen route', () => {
    expect(rerouteDeltaLabel(180, 1_240)).toBe('3 min slower · 1.2 km longer');
    expect(rerouteDeltaLabel(-120, -800)).toBe('2 min faster · 0.8 km shorter');
    expect(rerouteDeltaLabel(240, -300)).toBe('4 min slower · 0.3 km shorter');
  });

  it('does not report differences that round away', () => {
    expect(rerouteDeltaLabel(20, 40)).toBe('Same time and distance');
    expect(rerouteDeltaLabel(20, 900)).toBe('0.9 km longer');
  });

  it('describes each off-route behaviour distinctly', () => {
    const descriptions = (['adaptive', 'ask-first', 'keep-route'] as const).map(
      rerouteModeDescription,
    );
    expect(new Set(descriptions).size).toBe(3);
    expect(rerouteModeDescription('ask-first')).toContain('waits for you');
    expect(rerouteModeDescription('keep-route')).toContain('the route you chose');
  });
});

describe('guidance settings from native preferences', () => {
  it('adopts what the navigation core reports', () => {
    expect(
      guidanceSettingsFromNative(DEFAULT_GUIDANCE_SETTINGS, {
        audioMode: 'muted',
        rerouteMode: 'ask-first',
        speedingAudibleWarning: true,
        speedingToleranceKph: 10,
      }),
    ).toEqual({
      audioMode: 'muted',
      rerouteMode: 'ask-first',
      speedingAudibleWarning: true,
      speedingToleranceKph: 10,
    });
  });

  it('keeps current values for fields an event does not carry', () => {
    const current = { ...DEFAULT_GUIDANCE_SETTINGS, rerouteMode: 'keep-route' } as const;
    expect(guidanceSettingsFromNative(current, { audioMode: 'alerts-only' })).toEqual({
      ...current,
      audioMode: 'alerts-only',
    });
    // Tolerance 0 and audible false are real choices, not "absent".
    expect(
      guidanceSettingsFromNative(
        { ...current, speedingAudibleWarning: true },
        { speedingAudibleWarning: false, speedingToleranceKph: 0 },
      ),
    ).toMatchObject({ speedingAudibleWarning: false, speedingToleranceKph: 0 });
  });
});
