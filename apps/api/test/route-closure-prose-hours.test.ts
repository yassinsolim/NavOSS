import { describe, expect, it } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { createProvincial511RoadEventFeed } from '../src/provincial-511-road-event-feed.js';
import { selectClosureEvents } from '../src/route-closures/events.js';
import ontario from './fixtures/road-events/ontario-511-event-documentation-sample.json' with { type: 'json' };

const NOW = Date.parse('2026-11-27T17:00:00Z'); // Noon in Ontario, outside the stated overnight hours.
const SAMPLE = fixtureValue(ontario.rows[0]);

async function selectWithProse(field?: 'Description' | 'Comment' | 'Impact', text?: string) {
  const row = {
    ...SAMPLE,
    Description: 'Full road closure on HWY 401 Eastbound Express.',
    Comment: null,
    Impact: null,
    IsFullClosure: true,
    LanesAffected: 'All lanes closed',
    StartDate: NOW / 1_000 - 60,
    PlannedEndDate: NOW / 1_000 + 7 * 24 * 60 * 60,
    Reported: NOW / 1_000 - 60,
    LastUpdated: NOW / 1_000 - 60,
    Recurrence: '',
    RecurrenceSchedules: '',
    ...(field === undefined ? {} : { [field]: text }),
  };
  const feed = createProvincial511RoadEventFeed('ontario', 'fixture-only-key', {
    clock: () => NOW,
    fetchImplementation: () => Promise.resolve(new Response(JSON.stringify([row]))),
  });
  try {
    return selectClosureEvents([await feed.getSnapshot()], NOW);
  } finally {
    feed.stop();
  }
}

describe('511 full closures with unstructured operating hours', () => {
  it.each([
    ['Comment', SAMPLE.Comment],
    ['Description', 'Road closed between 9:00 PM and 5:00 AM.'],
    ['Impact', 'Road closed from 9 p.m. to 5 a.m.'],
    ['Comment', 'Road closed overnight.'],
    ['Comment', 'Road closed Mondays.'],
    ['Impact', 'Road closed every evening.'],
    ['Description', 'Full road closure on weekends.'],
    ['Comment', 'Road closed during rush hour.'],
  ] as const)('does not turn %s prose into an all-day closure: %s', async (field, text) => {
    const selected = await selectWithProse(field, text);
    expect(selected.events).toEqual([]);
    expect(selected.rejected['schedule-uncertain']).toBe(1);
  });

  it('keeps an explicit continuous full closure with no temporal prose', async () => {
    const selected = await selectWithProse();
    expect(selected.events).toHaveLength(1);
    expect(selected.events[0]?.sourceId).toBe('ontario-511-events');
    expect(selected.events[0]?.direction).toBe('east');
    expect(selected.rejected['schedule-uncertain']).toBeUndefined();
  });
});
