import { describe, expect, it } from 'vitest';

import { keyZoom, stickPanCenter } from '../src/features/map/map-keys.js';

const view = { bearing: 0, center: [-114.07, 51.05] as [number, number], zoom: 14 };

describe('stickPanCenter', () => {
  it('moves the map centre the way the stick points, north up', () => {
    const [lng, lat] = stickPanCenter(view, { x: 1, y: 0 }, 0.1);
    expect(lng).toBeGreaterThan(view.center[0]);
    expect(lat).toBeCloseTo(view.center[1], 6);
    const [lng2, lat2] = stickPanCenter(view, { x: 0, y: -1 }, 0.1);
    expect(lat2).toBeGreaterThan(view.center[1]);
    expect(lng2).toBeCloseTo(view.center[0], 6);
  });

  it('follows the screen on a rotated map: up on a map facing east moves east', () => {
    const [lng, lat] = stickPanCenter({ ...view, bearing: 90 }, { x: 0, y: -1 }, 0.1);
    expect(lng).toBeGreaterThan(view.center[0]);
    expect(lat).toBeCloseTo(view.center[1], 6);
  });

  it('moves a fixed share of the screen at any zoom: twice as far one zoom level out', () => {
    const near = stickPanCenter(view, { x: 1, y: 0 }, 0.1)[0] - view.center[0];
    const far = stickPanCenter({ ...view, zoom: 13 }, { x: 1, y: 0 }, 0.1)[0] - view.center[0];
    expect(far / near).toBeCloseTo(2, 6);
  });

  it('stays still at rest', () => {
    expect(stickPanCenter(view, { x: 0, y: 0 }, 0.1)).toEqual(view.center);
  });
});

describe('keyZoom', () => {
  it('steps one level and stays inside the map limits', () => {
    expect(keyZoom(14, 'zoom-in')).toBe(15);
    expect(keyZoom(14.4, 'zoom-out')).toBe(13.4);
    expect(keyZoom(19.6, 'zoom-in')).toBe(20);
    expect(keyZoom(2.5, 'zoom-out')).toBe(2);
  });
});
