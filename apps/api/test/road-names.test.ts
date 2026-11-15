import protobuf from 'protobufjs/light.js';
import { describe, expect, it, vi } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import {
  primaryLegacyRoadName,
  primaryRoadName,
  spokenInstruction,
  writtenInstruction,
} from '../src/road-names.js';
import { createValhallaRouteProvider } from '../src/route-provider.js';
import descriptor from '../src/valhalla-proto-3.8.2.json' with { type: 'json' };
import { parseValhallaPbf } from '../src/valhalla-pbf.js';
import calgary from './fixtures/valhalla/calgary-deerfoot-glenmore.json' with { type: 'json' };
import legacy from './fixtures/valhalla/calgary-legacy-osrm.json' with { type: 'json' };
import montreal from './fixtures/valhalla/montreal-a520-a40-a15.json' with { type: 'json' };
import toronto from './fixtures/valhalla/toronto-403-401-interchanges.json' with { type: 'json' };
import vancouver from './fixtures/valhalla/vancouver-highway-interchange.json' with { type: 'json' };

const ApiType = protobuf.Root.fromJSON(descriptor.schema).lookupType('valhalla.Api');
const steps = (fixture: { response: unknown }) =>
  fixtureValue(
    parseValhallaPbf(
      ApiType.encode(
        ApiType.fromObject(fixture.response as Record<string, unknown>),
      ).finish() as Uint8Array<ArrayBuffer>,
    )[0],
  ).steps;

const route = (value: string) => ({ isRouteNumber: true, value });
const name = (value: string) => ({ isRouteNumber: false, value });

describe('road names drivers see and hear', () => {
  // Names, instructions and cues as production returned them on 2026-11-15 (Square One to
  // Scarborough Town Centre, Toronto to Vancouver): Valhalla's order, route number first.
  const express = [route('401'), name('Highway 401 Express'), name('Macdonald-Cartier Freeway')];
  const transCanada = [name('Trans-Canada Highway'), name('Route Transcanadienne')];
  const gardiner = [name('Gardiner Expressway'), name('Frederick G. Gardiner Expressway')];

  it('shows one road name, the posted one, never the OSM name list', () => {
    expect(primaryRoadName(express)).toBe('Highway 401 Express');
    expect(primaryRoadName(transCanada)).toBe('Trans-Canada Highway');
    expect(primaryRoadName(gardiner)).toBe('Gardiner Expressway');
    expect(primaryRoadName([name('Wellington Street'), name('rue Wellington')])).toBe(
      'Wellington Street',
    );
    expect(primaryRoadName([route('17')])).toBe('17');
    expect(primaryRoadName([])).toBe('');
    expect(primaryLegacyRoadName('Wellington Street; rue Wellington')).toBe('Wellington Street');
    expect(primaryLegacyRoadName('16 Avenue NE')).toBe('16 Avenue NE');
  });

  it('writes a road once, keeping a route number its name does not carry', () => {
    expect(
      writtenInstruction('Keep left to take 401/Highway 401 Express/Macdonald-Cartier Freeway.', [
        express,
      ]),
    ).toBe('Keep left to take Highway 401 Express.');
    expect(
      writtenInstruction('Keep right to take Trans-Canada Highway/Route Transcanadienne.', [
        transCanada,
      ]),
    ).toBe('Keep right to take Trans-Canada Highway.');
    expect(
      writtenInstruction('Keep right to take exit 70 onto 15/Autoroute des Laurentides.', [
        [route('15'), name('Autoroute des Laurentides')],
      ]),
    ).toBe('Keep right to take exit 70 onto 15/Autoroute des Laurentides.');
  });

  it('says the road name only and does not capitalise a chained cue', () => {
    expect(spokenInstruction('Keep left to take 401, Highway 401 Express.', [express])).toBe(
      'Keep left to take Highway 401 Express.',
    );
    expect(
      spokenInstruction('Keep right to take Trans-Canada Highway, Route Transcanadienne.', [
        transCanada,
      ]),
    ).toBe('Keep right to take Trans-Canada Highway.');
    expect(spokenInstruction('Turn right to take the ramp. Then Bear right onto 17.', [])).toBe(
      'Turn right to take the ramp. Then bear right onto 17.',
    );
    expect(spokenInstruction('Turn left. Then Your destination will be on the right.', [])).toBe(
      'Turn left. Then your destination will be on the right.',
    );
    // Sign destinations are not one road's names and keep their commas.
    expect(spokenInstruction('Keep right toward Richmond, Vancouver.', [express])).toBe(
      'Keep right toward Richmond, Vancouver.',
    );
  });

  it('applies the rule to every step of recorded Valhalla routes', () => {
    const all = [calgary, montreal, toronto, vancouver].flatMap(steps);
    for (const step of all) {
      expect(step.roadName).not.toContain(';');
      expect(step.currentRoadName ?? '').not.toContain(';');
      expect(step.spokenInstruction ?? '').not.toMatch(/\. Then [A-Z]/u);
    }

    const ontario = steps(toronto);
    expect(ontario.map(({ spokenInstruction: cue }) => cue)).toContain(
      'Keep left to stay on Highway 401 Collector.',
    );
    expect(ontario.map(({ instruction }) => instruction)).toContain(
      'Keep left to stay on Highway 401 Collector.',
    );
    expect(ontario.map(({ spokenInstruction: cue }) => cue)).toContain(
      'Drive northwest. Then turn right onto Square One Drive.',
    );

    const quebec = steps(montreal);
    expect(quebec.map(({ spokenInstruction: cue }) => cue)).toContain(
      'Keep left to stay on Autoroute de la Côte-de-Liesse.',
    );

    const alberta = steps(calgary);
    const sixteenth = fixtureValue(alberta.find(({ roadName }) => roadName === '16 Avenue NE'));
    expect(sixteenth.instruction).toBe('Turn left onto 1/16 Avenue NE.');
    expect(sixteenth.spokenInstruction).toBe('Turn left onto 16 Avenue NE.');
  });

  it('cleans legacy /v1 road names and chained cues the same way', async () => {
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(legacy.response))),
    });
    const [first] = await provider.getRoutes(calgary.request);
    expect(fixtureValue(first).steps.map(({ spokenInstruction: cue }) => cue)).toContain(
      'Turn left onto 75 Avenue SW. Then turn left onto Kew Street SW.',
    );
  });
});
