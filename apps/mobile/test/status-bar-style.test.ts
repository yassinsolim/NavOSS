import { describe, expect, it } from 'vitest';

import { navigationBarStyleFor, statusBarContent } from '../src/features/map/status-bar-style.js';

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

describe('Android navigation bar buttons', () => {
  it('use the status bar content colour: dark buttons on a light bar, light on a dark one', () => {
    // expo-navigation-bar names the bar, not its content: a `light` bar has dark buttons.
    expect(navigationBarStyleFor('dark')).toBe('light');
    expect(navigationBarStyleFor('light')).toBe('dark');
    expect(navigationBarStyleFor('auto')).toBe('auto');
  });
});
