import { describe, expect, it } from 'vitest';

import {
  RouteAlternativeV2Schema,
  RouteLaneSchema,
  RouteRequestSchema,
  RouteRequestV2Schema,
  RouteSpeedLimitSchema,
  RouteStepV2Schema,
} from '../src/index.js';

const request = {
  origin: { latitude: 51.04427, longitude: -114.06309 },
  destination: { latitude: 49.2827, longitude: -123.1207 },
};
const waypoint = { latitude: 51.1784, longitude: -115.5708 };
const step = {
  distanceMeters: 100,
  durationSeconds: 20,
  geometry: [
    [-114.06309, 51.04427],
    [-114.062, 51.045],
  ],
  instruction: 'Turn right.',
  maneuverType: 'turn',
  roadName: 'Example road',
};

describe('versioned route enrichment contract', () => {
  it('defaults v2 waypoint types to break and accepts a through rejoin point', () => {
    expect(
      RouteRequestV2Schema.parse({ ...request, waypoints: [waypoint] }).waypoints?.[0]?.type,
    ).toBe('break');
    expect(
      RouteRequestV2Schema.parse({ ...request, waypoints: [{ ...waypoint, type: 'through' }] })
        .waypoints?.[0]?.type,
    ).toBe('through');
    expect(
      RouteRequestV2Schema.safeParse({ ...request, waypoints: [{ ...waypoint, type: 'via' }] })
        .success,
    ).toBe(false);
    expect(
      RouteRequestSchema.safeParse({ ...request, waypoints: [{ ...waypoint, type: 'through' }] })
        .success,
    ).toBe(false);
    expect(RouteRequestSchema.safeParse({ ...request, waypoints: [waypoint] }).success).toBe(true);
  });

  it('keeps coordinate validation and duplicate-stop rejection for through waypoints', () => {
    expect(
      RouteRequestV2Schema.safeParse({
        ...request,
        waypoints: [{ ...request.origin, type: 'through' }],
      }).success,
    ).toBe(false);
    expect(
      RouteRequestV2Schema.safeParse({
        ...request,
        waypoints: [{ latitude: 91, longitude: 0, type: 'through' }],
      }).success,
    ).toBe(false);
  });

  it('allows absent guidance while validating all new optional step fields', () => {
    expect(RouteStepV2Schema.safeParse(step).success).toBe(true);
    expect(
      RouteStepV2Schema.safeParse({
        ...step,
        currentRoadName: 'Example road',
        maneuverModifier: 'right',
        roundaboutExit: 3,
        bearingBeforeDegrees: 270,
        bearingAfterDegrees: 0,
        exitNumber: '23B',
        signpost: '99 North: Vancouver',
        signpostBranch: ['99 North'],
        signpostToward: ['Vancouver'],
        junctionName: 'Named junction',
        lanes: [
          {
            indications: ['straight', 'right'],
            valid: true,
            active: true,
            validIndication: 'right',
          },
        ],
      }).success,
    ).toBe(true);
    expect(RouteStepV2Schema.safeParse({ ...step, roundaboutExit: 0 }).success).toBe(false);
    expect(RouteStepV2Schema.safeParse({ ...step, bearingAfterDegrees: 360 }).success).toBe(false);
    expect(RouteStepV2Schema.safeParse({ ...step, lanes: [] }).success).toBe(false);
  });

  it('does not label an invalid lane active or select an indication missing from its lane', () => {
    expect(
      RouteLaneSchema.safeParse({ indications: ['left'], valid: false, active: true }).success,
    ).toBe(false);
    expect(
      RouteLaneSchema.safeParse({ indications: ['left'], valid: true, validIndication: 'right' })
        .success,
    ).toBe(false);
    expect(RouteLaneSchema.safeParse({ indications: [], valid: false }).success).toBe(true);
  });

  it('keeps unknown/unlimited posted limits explicit and enforces segment alignment', () => {
    expect(RouteSpeedLimitSchema.parse({ status: 'unknown' })).toEqual({ status: 'unknown' });
    expect(RouteSpeedLimitSchema.parse({ status: 'unlimited' })).toEqual({ status: 'unlimited' });
    expect(RouteSpeedLimitSchema.safeParse({ status: 'known', kph: 0 }).success).toBe(false);
    const route = {
      distanceMeters: 100,
      durationSeconds: 20,
      geometry: step.geometry,
      id: 'contract-test',
      label: 'fastest',
      steps: [step],
      speedLimitsKph: [0],
      speedLimits: [{ status: 'unknown' }],
    };
    expect(RouteAlternativeV2Schema.safeParse(route).success).toBe(true);
    expect(
      RouteAlternativeV2Schema.safeParse({
        ...route,
        speedLimits: [{ status: 'unknown' }, { status: 'known', kph: 50 }],
      }).success,
    ).toBe(false);
  });
});
