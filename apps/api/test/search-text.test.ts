import { describe, expect, it } from 'vitest';

import { normalizeSearchText, prefixTsQuery } from '../src/search-text.js';

describe('Calgary search text', () => {
  it('normalizes long and abbreviated Calgary addresses to the same key', () => {
    expect(normalizeSearchText('800 Macleod Trail Southeast')).toBe('800 macleod tr se');
    expect(normalizeSearchText('800 MACLEOD TR SE')).toBe('800 macleod tr se');
  });

  it('normalizes punctuation in business names for autocomplete', () => {
    expect(normalizeSearchText('Cosmos Collision')).toBe('cosmos collision');
    expect(normalizeSearchText('Co-op Wine, Spirits & Beer')).toBe('co op wine spirits and beer');
  });

  it('builds a prefix query from normalized words', () => {
    expect(prefixTsQuery('800 Macleod Trail SE')).toBe('800:* & macleod:* & tr:* & se:*');
  });
});
