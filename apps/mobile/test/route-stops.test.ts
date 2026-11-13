import { describe, expect, it } from 'vitest';

import {
  MAX_ROUTE_DESTINATIONS,
  moveRouteStop,
  routeStopRole,
} from '../src/features/navigation/route-stops.js';

describe('route stops', () => {
  it('swaps a stop with its neighbour without mutating the draft', () => {
    const draft = ['library', 'hotel', 'airport'] as const;
    expect(moveRouteStop(draft, 1, -1)).toEqual(['hotel', 'library', 'airport']);
    expect(moveRouteStop(draft, 1, 1)).toEqual(['library', 'airport', 'hotel']);
    expect(draft).toEqual(['library', 'hotel', 'airport']);
  });

  it('returns the same list when a move would leave it, so nothing re-renders', () => {
    const draft = ['library', 'airport'];
    expect(moveRouteStop(draft, 0, -1)).toBe(draft);
    expect(moveRouteStop(draft, 1, 1)).toBe(draft);
    expect(moveRouteStop(draft, 5, -1)).toBe(draft);
  });

  it('treats the last place as the destination, whatever was moved there', () => {
    expect(routeStopRole(0, 3)).toEqual({ kind: 'stop', label: 'Stop 1', marker: '1' });
    expect(routeStopRole(1, 3)).toEqual({ kind: 'stop', label: 'Stop 2', marker: '2' });
    expect(routeStopRole(2, 3)).toEqual({ kind: 'destination', label: 'Destination', marker: 'B' });
    expect(routeStopRole(0, 1).kind).toBe('destination');
  });

  it('allows eight stops and a destination', () => {
    expect(MAX_ROUTE_DESTINATIONS).toBe(9);
  });
});
