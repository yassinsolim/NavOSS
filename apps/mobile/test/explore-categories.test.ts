import { describe, expect, it } from 'vitest';
import { SearchCategorySchema } from '@navoss/contracts';

import {
  EXPLORE_CATEGORY_GROUPS,
  exploreCategoryById,
  QUICK_EXPLORE_CATEGORIES,
} from '../src/features/map/explore-categories.js';

describe('explore categories', () => {
  it('provides the requested quick categories in a stable order', () => {
    expect(QUICK_EXPLORE_CATEGORIES.map(({ label }) => label)).toEqual([
      'Restaurants',
      'Cafe',
      'Gas',
      'Groceries',
      'Shopping',
      'Beauty salons',
      'Parks',
    ]);
  });

  it('uses distinct ids and useful search queries across granular groups', () => {
    const categories = EXPLORE_CATEGORY_GROUPS.flatMap((group) => group.categories);

    expect(new Set(categories.map(({ id }) => id)).size).toBe(categories.length);
    expect(categories.every(({ label, query }) => label.length > 0 && query.length >= 2)).toBe(
      true,
    );
    expect(EXPLORE_CATEGORY_GROUPS.map(({ label }) => label)).toEqual([
      'Food & Drink',
      'Things to do',
      'Shopping',
      'Services',
    ]);
  });

  it('resolves categories for quick actions and the More sheet', () => {
    expect(exploreCategoryById('coffee')).toMatchObject({ label: 'Coffee', query: 'cafe' });
    expect(exploreCategoryById('gas')).toMatchObject({ label: 'Gas', query: 'fuel' });
    expect(exploreCategoryById('missing')).toBeUndefined();
  });

  it('sends typed intent for every supported filter exactly once', () => {
    const categories = EXPLORE_CATEGORY_GROUPS.flatMap((group) => group.categories);
    expect(categories.map(({ searchCategory }) => searchCategory).sort()).toEqual(
      [...SearchCategorySchema.options].sort(),
    );
  });
});
