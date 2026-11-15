import { describe, expect, it } from 'vitest';
import type { SearchResult, SearchSource } from '@navoss/contracts';

import {
  categoryLabelValid,
  judgeCategoryResults,
  judgeOntarioEvents,
  regionalSourceValid,
} from '../src/search-quality-judge.js';

// Recorded from /v1/search, downtown Calgary, 2026-11-15. Mutations below exercise failure cases.
const clothing: SearchResult = {
  category: 'poi',
  center: { latitude: 51.0459822, longitude: -114.071189 },
  confidence: 0.55,
  distanceMeters: 151,
  details: {
    address:
      'Brooks Brothers, 751, 3 Street SW, Downtown Commercial Core, Calgary, Alberta, T2P 4K8, Canada',
    category: 'clothing store',
  },
  id: 'nominatim:node:9646659989',
  label: 'Brooks Brothers, 751 3 Street SW, Calgary',
  name: 'Brooks Brothers',
};
const pub: SearchResult = {
  category: 'poi',
  center: { latitude: 51.0454349, longitude: -114.0668336 },
  confidence: 0.55,
  distanceMeters: 363,
  details: {
    address:
      'The Unicorn, 223, 8 Avenue SW, Downtown Commercial Core, Calgary, Alberta, T2P 1B5, Canada',
    category: 'pub',
  },
  id: 'nominatim:way:1034725239',
  label: 'The Unicorn, 223 8 Avenue SW, Calgary',
  name: 'The Unicorn',
};
const source: SearchSource = {
  datasetVersion: 'canada-geofabrik-2026-11-14',
  freshness: 'fresh',
  id: 'nominatim-self-hosted',
  updatedAt: '2026-11-15T18:05:28.874Z',
};

describe('live search quality judging', () => {
  it('compares recorded display labels against the API raw-type mapping', () => {
    expect(judgeCategoryResults('apparel', [clothing], source).typesValid).toBe(true);
    expect(judgeCategoryResults('bar', [pub], source).typesValid).toBe(true);
    expect(judgeCategoryResults('bar', [clothing], source).typesValid).toBe(false);
    expect(
      judgeCategoryResults('bar', [{ ...pub, details: { category: 'beauty salon' } }], source)
        .typesValid,
    ).toBe(false);
    expect(judgeCategoryResults('bar', [{ ...pub, details: undefined }], source).typesValid).toBe(
      false,
    );
    expect(categoryLabelValid('restaurant', 'food court')).toBe(true);
    expect(categoryLabelValid('restaurant', 'indian restaurant')).toBe(true);
    expect(categoryLabelValid('takeout', 'fast food')).toBe(true);
    expect(categoryLabelValid('bar', 'indian pub')).toBe(false);
    expect(categoryLabelValid('restaurant', 'unknown local barber restaurant')).toBe(false);
  });
  it('detects barbers, unsorted distances, and Calgary index leaks', () => {
    expect(judgeCategoryResults('bar', [{ ...pub, name: 'Barber Shop' }], source).noBarbers).toBe(
      false,
    );
    expect(judgeCategoryResults('bar', [pub, { ...pub, distanceMeters: 100 }], source).sorted).toBe(
      false,
    );
    expect(judgeCategoryResults('bar', [pub, { ...pub, distanceMeters: 400 }], source).sorted).toBe(
      true,
    );
    expect(
      judgeCategoryResults('bar', [{ ...pub, id: 'calgary-123' }], source, 'british-columbia')
        .noCalgarySources,
    ).toBe(false);
    expect(judgeCategoryResults('bar', [pub], source, 'british-columbia').noCalgarySources).toBe(
      true,
    );
    expect(
      judgeCategoryResults(
        'bar',
        [{ ...pub, label: 'The Unicorn, Calgary, Alberta' }],
        source,
        'british-columbia',
      ).noCalgarySources,
    ).toBe(false);
  });

  it('checks the per-source Ontario events response and rejects stale or missing sources', () => {
    const events = {
      stale: false,
      sources: [
        { sourceId: 'ontario-511-events', status: 'not-configured' },
        { sourceId: 'toronto-road-restrictions', status: 'current' },
      ],
    };
    expect(judgeOntarioEvents(events)).toEqual({ fresh: true, sourcePresent: true });
    expect(judgeOntarioEvents({ ...events, stale: true }).fresh).toBe(false);
    expect(judgeOntarioEvents({ ...events, sources: [] }).sourcePresent).toBe(false);
    expect(judgeOntarioEvents({ sources: events.sources }).fresh).toBe(false);
  });

  it('requires Nominatim data covering the tested province, without pinning a release', () => {
    expect(regionalSourceValid(source, 'british-columbia')).toBe(true);
    expect(
      regionalSourceValid({ ...source, datasetVersion: 'canada-geofabrik-2030-01-01' }, 'quebec'),
    ).toBe(true);
    expect(
      regionalSourceValid(
        { ...source, datasetVersion: 'alberta-british-columbia-geofabrik-2026-07-30' },
        'british-columbia',
      ),
    ).toBe(true);
    expect(
      regionalSourceValid(
        { ...source, datasetVersion: 'alberta-geofabrik-2026-07-30' },
        'british-columbia',
      ),
    ).toBe(false);
    expect(
      regionalSourceValid(
        { ...source, datasetVersion: 'british-columbia-geofabrik-2026-07-30' },
        'ontario',
      ),
    ).toBe(false);
    expect(regionalSourceValid({ ...source, datasetVersion: 'canada' }, 'ontario')).toBe(false);
    expect(
      regionalSourceValid({ ...source, id: 'calgary-hybrid-search' }, 'british-columbia'),
    ).toBe(false);
    expect(regionalSourceValid(undefined, 'british-columbia')).toBe(false);
  });
});
