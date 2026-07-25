import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

import {
  createContributionDraft,
  loadContributionDrafts,
  normalizeContributionDrafts,
  saveContributionDrafts,
} from '../src/features/map/contribution-drafts.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('local contribution drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a bounded private draft', () => {
    const draft = createContributionDraft(
      'route-issue',
      '  Turn instruction sends drivers into a closed lane.  ',
      '  17 Avenue SW  ',
      new Date('2026-04-24T16:00:00.000Z'),
    );

    expect(draft).toMatchObject({
      createdAt: '2026-04-24T16:00:00.000Z',
      description: 'Turn instruction sends drivers into a closed lane.',
      location: '17 Avenue SW',
      type: 'route-issue',
    });
  });

  it('rejects malformed stored records', () => {
    expect(
      normalizeContributionDrafts([
        {
          createdAt: '2026-04-24T16:00:00.000Z',
          description: 'Missing cafe',
          id: 'valid',
          type: 'missing-place',
        },
        { createdAt: 'not-a-date', description: '', id: '', type: 'invented' },
      ]),
    ).toHaveLength(1);
  });

  it('loads and saves drafts only in local app storage', async () => {
    const draft = createContributionDraft(
      'road-change',
      'New turn restriction',
      undefined,
      new Date('2026-04-24T16:00:00.000Z'),
    );
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify([draft]));

    await expect(loadContributionDrafts()).resolves.toEqual([draft]);
    await saveContributionDrafts([draft]);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'navoss.contribution-drafts.v1',
      JSON.stringify([draft]),
    );
  });

  it('serializes deferred writes and makes reads wait for the newest write', async () => {
    const firstDraft = createContributionDraft(
      'missing-place',
      'Add the new cafe',
      undefined,
      new Date('2026-04-24T16:00:00.000Z'),
    );
    const secondDraft = createContributionDraft(
      'place-correction',
      'Correct the cafe hours',
      undefined,
      new Date('2026-04-24T16:01:00.000Z'),
    );
    const firstWrite = deferred();
    const secondWrite = deferred();
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify([secondDraft]));

    const firstSave = saveContributionDrafts([firstDraft]);
    const secondSave = saveContributionDrafts([secondDraft]);
    const load = loadContributionDrafts();
    await Promise.resolve();

    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();

    firstWrite.resolve();
    await firstSave;
    await Promise.resolve();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2);
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();

    secondWrite.resolve();
    await secondSave;
    await expect(load).resolves.toEqual([secondDraft]);
    expect(AsyncStorage.setItem).toHaveBeenNthCalledWith(
      2,
      'navoss.contribution-drafts.v1',
      JSON.stringify([secondDraft]),
    );
  });
});
