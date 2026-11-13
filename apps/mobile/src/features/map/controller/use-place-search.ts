import type { Coordinate, SearchResult, SearchSource } from '@navoss/contracts';
import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';

import type { ExploreCategory } from '@/features/map/explore-categories';
import { createLatestRequestGate } from '@/features/map/latest-request-gate';
import {
  planPlaceSearch,
  rankCategoryResults,
  rankSearchResults,
  searchProximityKey,
  searchProximityOptions,
  searchResultBounds,
  type SettledPlaceSearch,
} from '@/features/map/search-proximity';
import { getRecentDestinationIds } from '@/features/navigation/native-navigation';
import { searchPlaces } from '@/lib/api';

export type SearchState = 'error' | 'idle' | 'loading' | 'success';
export type SearchResultBounds = [west: number, south: number, east: number, north: number];

export interface RunPlaceSearchOptions {
  /** Announce a loading state. A refresh of the query already on screen passes false. */
  announceLoading?: boolean;
  category?: ExploreCategory;
  /** Fit the map to the results once they arrive. */
  fitResults?: boolean;
  /** Category browsing ranks by distance alone; typed search also weighs recents. */
  nearestFirst?: boolean;
  proximityOrigin?: Coordinate | undefined;
}

export interface PlaceSearch {
  /** Cancels any in-flight request so its response can never land. */
  invalidate: () => number;
  query: string;
  /** Empties the result list and returns to the idle state. */
  resetResults: () => void;
  results: SearchResult[];
  run: (normalizedQuery: string, options?: RunPlaceSearchOptions) => AbortController;
  searchSource: SearchSource | undefined;
  searchState: SearchState;
  selectedCategoryId: string | undefined;
  /** While a category search is on screen, typed-query debouncing is suspended. */
  setCategorySearchActive: (active: boolean) => void;
  setQuery: (query: string) => void;
  setSelectedCategoryId: (id: string | undefined) => void;
}

/**
 * Place search: the typed query and its debounce, category browsing, request cancellation and
 * the result list. It knows nothing about the map or the selected place; the controller wires
 * those together.
 */
export function usePlaceSearch({
  onConnectionChange,
  onFitResults,
  searchOrigin,
  selectedResultName,
}: {
  onConnectionChange: (connection: 'offline' | 'online') => void;
  onFitResults: (bounds: SearchResultBounds) => void;
  searchOrigin: Coordinate | undefined;
  selectedResultName: string | undefined;
}): PlaceSearch {
  const abortControllerRef = useRef<AbortController>(null);
  const requestGateRef = useRef(createLatestRequestGate());
  const displayedSearchRef = useRef<SettledPlaceSearch | undefined>(undefined);
  const categorySearchActiveRef = useRef(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchSource, setSearchSource] = useState<SearchSource>();
  const [searchState, setSearchState] = useState<SearchState>('idle');
  // The typed search the visible results answer; loading is announced only for a different query.
  const [settledSearch, setSettledSearch] = useState<SettledPlaceSearch>();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>();
  const searchOriginKey = searchProximityKey(searchOrigin);
  const displayedSearch = searchState === 'success' ? settledSearch : undefined;

  const invalidate = (): number => {
    const requestGeneration = requestGateRef.current.advance();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    return requestGeneration;
  };

  const run = (
    normalizedQuery: string,
    {
      announceLoading = true,
      category,
      fitResults = false,
      nearestFirst = false,
      proximityOrigin = searchOrigin,
    }: RunPlaceSearchOptions = {},
  ): AbortController => {
    const requestGeneration = invalidate();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    if (announceLoading) setSearchState('loading');

    void searchPlaces(normalizedQuery, {
      ...searchProximityOptions(proximityOrigin),
      includeDetails: true,
      ...(category?.searchCategory === undefined ? {} : { category: category.searchCategory }),
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted || !requestGateRef.current.isCurrent(requestGeneration)) {
          return;
        }
        const rankedResults = nearestFirst
          ? rankCategoryResults(response.results, proximityOrigin)
          : rankSearchResults(response.results, getRecentDestinationIds(), proximityOrigin);
        startTransition(() => {
          onConnectionChange('online');
          setResults(rankedResults);
          setSearchSource(response.source);
          setSettledSearch(
            category === undefined
              ? { proximityKey: searchProximityKey(proximityOrigin), query: normalizedQuery }
              : undefined,
          );
          setSearchState('success');
        });
        if (fitResults) {
          const bounds = searchResultBounds(rankedResults);
          if (bounds !== undefined) {
            requestAnimationFrame(() => {
              onFitResults(bounds);
            });
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && requestGateRef.current.isCurrent(requestGeneration)) {
          startTransition(() => {
            onConnectionChange('offline');
            setResults([]);
            setSearchState('error');
          });
        }
      })
      .finally(() => {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
      });
    return controller;
  };

  useEffect(() => {
    displayedSearchRef.current = displayedSearch;
  }, [displayedSearch]);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();
    if (
      categorySearchActiveRef.current ||
      normalizedQuery.length < 2 ||
      normalizedQuery.toLocaleLowerCase('en-CA') === selectedResultName?.toLocaleLowerCase('en-CA')
    ) {
      return;
    }

    // Location fixes keep arriving while results are open. Only a new proximity cell may requery,
    // and a requery of the query already on screen must not re-announce loading over its results.
    // The loading flag is read through a ref so announcing loading cannot re-run and abort this
    // search. The committed settled identity is a dependency instead: a refresh that lands after
    // the location moved back must be replanned against the current cell, not stranded.
    const plan = planPlaceSearch(normalizedQuery, searchOriginKey, displayedSearchRef.current);
    if (plan === 'skip') return;

    let searchController: AbortController | undefined;
    const timeout = setTimeout(() => {
      searchController = run(normalizedQuery, { announceLoading: plan === 'search' });
    }, 250);

    return () => {
      clearTimeout(timeout);
      searchController?.abort();
    };
    // `run` closes over the latest search origin; the origin's proximity key is the dependency.
  }, [
    deferredQuery,
    searchOriginKey,
    selectedResultName,
    settledSearch?.proximityKey,
    settledSearch?.query,
  ]);

  useEffect(
    () => () => {
      requestGateRef.current.advance();
      abortControllerRef.current?.abort();
    },
    [],
  );

  return {
    invalidate,
    query,
    resetResults: () => {
      setResults([]);
      setSearchState('idle');
    },
    results,
    run,
    searchSource,
    searchState,
    selectedCategoryId,
    setCategorySearchActive: (active) => {
      categorySearchActiveRef.current = active;
    },
    setQuery,
    setSelectedCategoryId,
  };
}
