import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8');
}

describe('mobile motion surfaces', () => {
  it('animates search focus, states, and result rows with reduced-motion support', () => {
    const search = source('src/features/map/search-panel.tsx');

    expect(search).toContain('animatedSearchBarStyle');
    expect(search).toContain('FadeInDown.duration(220)');
    expect(search).toContain('.delay(Math.min(index, 5) * 28)');
    expect(search).toContain('ReduceMotion.System');
  });

  it('animates place details and route lifecycle without unstable layout changes', () => {
    const mapScreen = source('src/features/map/map-screen.tsx');
    const place = source('src/features/map/place-sheet.tsx');
    const routes = source('src/features/navigation/route-panels.tsx');

    expect(place).toContain('FadeInUp.duration(260)');
    expect(place).toContain('FadeOutDown.duration(180)');
    expect(place).toContain('animationDelay');
    expect(place).toContain('minHeight: 76');
    expect(place).toContain("width: '100%'");
    expect(routes).toContain('function RouteChoiceCard');
    expect(routes).toContain('withSpring(selected ? 1 : 0.965');
    expect(routes).toContain('LinearTransition.duration(200)');
    expect(routes).toContain('ReduceMotion.System');
    expect(routes).toContain('const compact = width < 390;');
    expect(routes).toContain('height: 44');
    expect(routes).toContain('minHeight: 154');
    expect(mapScreen).toContain('routeState.previewOrigin === undefined ? 416 : 484');
    expect(mapScreen).toContain('width < 390 ? 154 : 102');
  });

  it('keeps persistent tab and secondary-screen transitions motion-aware', () => {
    const tabs = source('src/features/map/app-tab-bar.tsx');
    const saved = source('src/features/map/saved-places-screen.tsx');
    const contribute = source('src/features/map/contribute-screen.tsx');

    expect(tabs).toContain('withSpring(selected ? 1 : 0.9');
    expect(tabs).toContain('ReduceMotion.System');
    expect(saved).toContain('FadeInRight.duration(220)');
    expect(contribute).toContain('FadeInRight.duration(220)');
  });
});
