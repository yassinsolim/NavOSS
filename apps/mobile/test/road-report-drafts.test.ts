import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

import {
  createRoadReportDraft,
  loadRoadReportDrafts,
  normalizeRoadReportDrafts,
  ROAD_REPORT_TYPES,
  saveRoadReportDrafts,
} from '../src/features/map/road-report-drafts.js';

describe('local road-report shadow drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers specific road conditions without police reporting', () => {
    expect(ROAD_REPORT_TYPES.map(({ id }) => id)).toEqual([
      'collision',
      'road-closure',
      'slow-traffic',
      'construction',
      'pothole',
      'object-on-road',
      'road-hazard',
      'stalled-vehicle',
    ]);
  });

  it('creates an expiring structured report without free text', () => {
    const report = createRoadReportDraft(
      'road-hazard',
      { latitude: 51.04427, longitude: -114.06309 },
      new Date('2026-07-27T12:00:00.000Z'),
    );

    expect(report).toMatchObject({
      coordinate: { latitude: 51.04427, longitude: -114.06309 },
      createdAt: '2026-07-27T12:00:00.000Z',
      expiresAt: '2026-07-27T14:00:00.000Z',
      type: 'road-hazard',
    });
    expect(report).not.toHaveProperty('description');
  });

  it('drops expired, malformed, and unsupported reports', () => {
    const active = createRoadReportDraft(
      'collision',
      { latitude: 43.6532, longitude: -79.3832 },
      new Date('2026-07-27T12:00:00.000Z'),
    );

    expect(
      normalizeRoadReportDrafts(
        [
          active,
          { ...active, id: 'expired', expiresAt: '2026-07-27T12:30:00.000Z' },
          { ...active, id: 'bad-coordinate', coordinate: { latitude: 200, longitude: 0 } },
          { ...active, id: 'unsupported', type: 'police' },
        ],
        new Date('2026-07-27T13:00:00.000Z'),
      ),
    ).toEqual([active]);
  });

  it('loads and saves reports only in local app storage', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const report = createRoadReportDraft(
      'stalled-vehicle',
      { latitude: 51.04427, longitude: -114.06309 },
      now,
    );
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify([report]));

    await expect(loadRoadReportDrafts(now)).resolves.toEqual([report]);
    await saveRoadReportDrafts([report], now);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'navoss.road-report-drafts.v1',
      JSON.stringify([report]),
    );
  });
});
