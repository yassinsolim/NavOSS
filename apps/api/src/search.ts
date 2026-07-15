import type { Coordinate, SearchQuery, SearchResponse, SearchResult } from '@navoss/contracts';

import { SEARCH_SOURCE, type SearchFixture } from './fixtures.js';

interface RankedFixture {
  confidence: number;
  distance: number;
  fixture: SearchFixture;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function textConfidence(fixture: SearchFixture, query: string): number | undefined {
  const candidates = [fixture.result.name, fixture.result.label, ...fixture.aliases].map(normalize);

  if (candidates.some((candidate) => candidate === query)) {
    return 1;
  }

  if (candidates.some((candidate) => candidate.startsWith(query))) {
    return 0.94;
  }

  if (candidates.some((candidate) => candidate.split(' ').some((word) => word.startsWith(query)))) {
    return 0.88;
  }

  if (candidates.some((candidate) => candidate.includes(query))) {
    return 0.82;
  }

  const queryWords = query.split(' ');
  if (candidates.some((candidate) => queryWords.every((word) => candidate.includes(word)))) {
    return 0.74;
  }

  return undefined;
}

function distanceSquared(from: Coordinate | undefined, to: Coordinate): number {
  if (from === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const latitudeDelta = from.latitude - to.latitude;
  const longitudeDelta = from.longitude - to.longitude;
  return latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta;
}

function toSearchResult(ranked: RankedFixture): SearchResult {
  return {
    ...ranked.fixture.result,
    confidence: ranked.confidence,
  };
}

export function searchFixtures(
  fixtures: readonly SearchFixture[],
  query: SearchQuery,
): SearchResponse {
  const normalizedQuery = normalize(query.q);
  const origin =
    query.latitude === undefined || query.longitude === undefined
      ? undefined
      : { latitude: query.latitude, longitude: query.longitude };

  const results = fixtures
    .map((fixture): RankedFixture | undefined => {
      const confidence = textConfidence(fixture, normalizedQuery);
      if (confidence === undefined) {
        return undefined;
      }

      return {
        confidence,
        distance: distanceSquared(origin, fixture.result.center),
        fixture,
      };
    })
    .filter((fixture): fixture is RankedFixture => fixture !== undefined)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.distance - right.distance ||
        left.fixture.result.label.localeCompare(right.fixture.result.label, 'en-CA') ||
        left.fixture.result.id.localeCompare(right.fixture.result.id, 'en-CA'),
    )
    .slice(0, query.limit)
    .map(toSearchResult);

  return {
    degraded: true,
    results,
    source: SEARCH_SOURCE,
  };
}
