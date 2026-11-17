import { describe, expect, it } from 'vitest';

import { statusBarContent } from '../src/features/map/status-bar-style.js';

describe('status bar content', () => {
  it('uses dark content over a light basemap and light content over a dark one', () => {
    expect(statusBarContent({ darkMap: false, mapVisible: true })).toBe('dark');
    expect(statusBarContent({ darkMap: true, mapVisible: true })).toBe('light');
  });

  it('follows the system when a full-screen page covers the map', () => {
    expect(statusBarContent({ darkMap: false, mapVisible: false })).toBe('auto');
    expect(statusBarContent({ darkMap: true, mapVisible: false })).toBe('auto');
  });
});
