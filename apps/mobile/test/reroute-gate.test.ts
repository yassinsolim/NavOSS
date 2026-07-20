import { describe, expect, it } from 'vitest';

import { RerouteGate } from '../src/features/navigation/reroute-gate.js';

describe('RerouteGate', () => {
  it('starts one request and suppresses duplicate off-route samples while it is pending', () => {
    const gate = new RerouteGate(10_000);

    expect(gate.shouldRequest(false, 1_000)).toBe(false);
    expect(gate.shouldRequest(true, 2_000)).toBe(true);
    expect(gate.shouldRequest(true, 20_000)).toBe(false);
  });

  it('retries only after the cooldown when a request finishes off route', () => {
    const gate = new RerouteGate(10_000);

    expect(gate.shouldRequest(true, 1_000)).toBe(true);
    gate.completeRequest();

    expect(gate.shouldRequest(true, 10_999)).toBe(false);
    expect(gate.shouldRequest(true, 11_000)).toBe(true);
  });

  it('keeps the cooldown across recovery but clears it for a new session', () => {
    const gate = new RerouteGate(10_000);

    expect(gate.shouldRequest(true, 1_000)).toBe(true);
    gate.completeRequest();

    expect(gate.shouldRequest(false, 1_001)).toBe(false);
    expect(gate.shouldRequest(true, 1_001)).toBe(false);

    gate.resetSession();

    expect(gate.shouldRequest(true, 1_001)).toBe(true);
  });
});
