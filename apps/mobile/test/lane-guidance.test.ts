import type { RouteLane, RouteResponseV2 } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import { laneStrip, maneuverSignage } from '../src/features/navigation/lane-guidance.js';
import { recordedRoutes } from './route-fixtures.js';

function recordedRoute(name: Parameters<typeof recordedRoutes>[0]) {
  const route = (recordedRoutes(name) as RouteResponseV2).routes[0];
  if (route === undefined) throw new Error(`${name} has no route`);
  return route;
}

function step(name: Parameters<typeof recordedRoutes>[0], index: number) {
  const value = recordedRoute(name).steps[index];
  if (value === undefined) throw new Error(`${name} has no step ${String(index)}`);
  return value;
}

describe('lane strip', () => {
  it('marks the one lane for Deerfoot Trail exit 248 (recorded)', () => {
    const strip = laneStrip(recordedRoute('calgary-deerfoot-glenmore.v2').steps[1]?.lanes);
    expect(strip?.tiles).toEqual([
      { arrows: [{ highlighted: false, indication: 'straight' }], state: 'other' },
      { arrows: [{ highlighted: false, indication: 'straight' }], state: 'other' },
      { arrows: [{ highlighted: true, indication: 'right' }], state: 'recommended' },
    ]);
    expect(strip?.accessibilityLabel).toBe('Use lane 3 of 3');
  });

  it('highlights the arrow to follow in a shared lane and draws it last (recorded)', () => {
    const strip = laneStrip(recordedRoute('calgary-deerfoot-glenmore.v2').steps[4]?.lanes);
    expect(strip?.tiles).toEqual([
      {
        arrows: [
          { highlighted: false, indication: 'slight_left' },
          { highlighted: true, indication: 'straight' },
        ],
        state: 'recommended',
      },
    ]);
  });

  it('offers both left-turn lanes onto Bridgeport Road (recorded)', () => {
    const strip = laneStrip(recordedRoute('vancouver-bc91-highway99.v2').steps[3]?.lanes);
    expect(strip?.tiles.map((tile) => tile.state)).toEqual(['recommended', 'recommended']);
    expect(strip?.tiles[1]?.arrows).toEqual([
      { highlighted: false, indication: 'straight' },
      { highlighted: true, indication: 'left' },
    ]);
    expect(strip?.accessibilityLabel).toBe('Use lanes 1 to 2 of 2');
  });

  it('separates the lanes the router prefers from other usable ones', () => {
    const lanes: RouteLane[] = [
      { indications: ['left'], valid: true },
      { active: true, indications: ['left', 'straight'], valid: true, validIndication: 'left' },
      { indications: ['straight'], valid: false },
      { active: true, indications: ['left'], valid: true },
    ];
    const strip = laneStrip(lanes);
    expect(strip?.tiles.map((tile) => tile.state)).toEqual([
      'usable',
      'recommended',
      'other',
      'recommended',
    ]);
    expect(strip?.accessibilityLabel).toBe('Use lanes 2 or 4 of 4');
  });

  it('shows nothing it cannot vouch for', () => {
    expect(laneStrip(undefined)).toBeUndefined();
    expect(laneStrip([])).toBeUndefined();
    expect(laneStrip([{ indications: ['left'], valid: false }])).toBeUndefined();
    expect(
      laneStrip([
        { indications: [], valid: true },
        { indications: ['left'], valid: true },
      ]),
    ).toBeUndefined();
    // A route without lane data, like every /v1/routes response.
    expect(laneStrip(recordedRoute('calgary-deerfoot-glenmore.v1').steps[1]?.lanes)).toBe(
      undefined,
    );
  });
});

describe('maneuver signage', () => {
  it('reads the exit number and signed destinations from the route (recorded)', () => {
    expect(maneuverSignage(step('vancouver-bc91-highway99.v2', 1))).toEqual({
      exitLabel: 'Exit 23B',
      toward: 'toward Vancouver-YVR International Airport / Vancouver',
    });
    // A branch alone ("14 Street W South") is a road, not a destination.
    expect(maneuverSignage(step('calgary-deerfoot-glenmore.v2', 4))).toEqual({});
  });

  it('names the roundabout exit only when the route states it', () => {
    const roundabout = { maneuverType: 'roundabout' };
    expect(maneuverSignage({ ...roundabout, roundaboutExit: 1 }).exitLabel).toBe('1st exit');
    expect(maneuverSignage({ ...roundabout, roundaboutExit: 2 }).exitLabel).toBe('2nd exit');
    expect(maneuverSignage({ ...roundabout, roundaboutExit: 3 }).exitLabel).toBe('3rd exit');
    expect(maneuverSignage({ ...roundabout, roundaboutExit: 11 }).exitLabel).toBe('11th exit');
    expect(maneuverSignage(roundabout)).toEqual({});
    expect(maneuverSignage({ maneuverType: 'turn', roundaboutExit: 2 })).toEqual({});
  });
});
