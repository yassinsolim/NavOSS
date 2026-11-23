/**
 * What Android's system back does on the map screen, one layer at a time: the route being
 * planned or previewed, then the open place, then a full-screen tab, then the search. Modal
 * sheets close themselves (their system modal hears back first) and the keyboard closes before
 * any of this. An active trip is never ended by back: only End stops navigation, so back
 * during a trip leaves the app with guidance still running.
 */
export type BackAction = 'cancel-route' | 'clear-search' | 'close-place' | 'explore-tab' | 'system';

export function mapBackAction({
  activeTab,
  hasSearch,
  placeOpen,
  routeState,
}: {
  activeTab: 'contribute' | 'explore' | 'saved';
  /** A query, category or results are showing in the explore sheet. */
  hasSearch: boolean;
  placeOpen: boolean;
  routeState: 'arrived' | 'error' | 'idle' | 'loading' | 'navigating' | 'preview';
}): BackAction {
  if (routeState === 'navigating' || routeState === 'arrived') return 'system';
  if (routeState !== 'idle') return 'cancel-route';
  if (placeOpen) return 'close-place';
  if (activeTab !== 'explore') return 'explore-tab';
  if (hasSearch) return 'clear-search';
  return 'system';
}
