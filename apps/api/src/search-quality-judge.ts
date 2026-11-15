import type { SearchCategory, SearchResponse, SearchResult } from '@navoss/contracts';

import { finalizeDetailCategory, SEARCH_CATEGORY_TYPES } from './search-provider.js';

/** Presentation labels can be shared by several raw tags, so this cannot recover the exact tag. */
export function categoryLabelValid(category: SearchCategory, label: string | undefined): boolean {
  if (label === undefined) return false;
  for (const rawType of SEARCH_CATEGORY_TYPES[category]) {
    const base = finalizeDetailCategory(rawType);
    if (base === label) return true;
    // The provider may prepend one or two tagged cuisine words to these place kinds.
    if (base !== undefined && label.endsWith(` ${base}`)) {
      const cuisine = label.slice(0, -base.length - 1);
      if (finalizeDetailCategory(rawType, cuisine) === label) return true;
    }
  }
  return false;
}

export function regionalSourceValid(
  source: SearchResponse['source'] | undefined,
  province: string,
): boolean {
  if (source?.id !== 'nominatim-self-hosted') return false;
  const region = /^([a-z][a-z0-9-]*)-geofabrik-\d{4}-\d{2}-\d{2}$/u.exec(
    source.datasetVersion,
  )?.[1];
  return region !== undefined && (region === 'canada' || `-${region}-`.includes(`-${province}-`));
}

export function judgeCategoryResults(
  category: SearchCategory,
  results: SearchResult[],
  source: SearchResponse['source'] | undefined,
  regionalProvince?: string,
) {
  return {
    sorted: results.every(
      (result, index) =>
        index === 0 ||
        (result.distanceMeters ?? Number.POSITIVE_INFINITY) >=
          (results[index - 1]?.distanceMeters ?? -1),
    ),
    typesValid: results.every((result) => categoryLabelValid(category, result.details?.category)),
    noBarbers:
      category !== 'bar' ||
      results.every((result) => !result.name.toLocaleLowerCase('en-CA').includes('barber')),
    noCalgarySources:
      regionalProvince === undefined ||
      results.every(
        (result) =>
          !result.id.startsWith('calgary-') &&
          !result.label.toLocaleLowerCase('en-CA').includes('calgary, alberta'),
      ),
    regionalSourceValid:
      regionalProvince === undefined || regionalSourceValid(source, regionalProvince),
  };
}

export function judgeOntarioEvents(body: { stale?: boolean; sources?: { sourceId: string }[] }) {
  return {
    sourcePresent:
      body.sources?.some((source) => source.sourceId === 'ontario-511-events') === true,
    fresh: body.stale === false,
  };
}
