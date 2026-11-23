import { describe, expect, it } from 'vitest';

import {
  dismissNotice,
  showNoticeInSlots,
  visibleNotice,
} from '../src/features/map/controller/map-notice-slots.js';

interface Notice {
  id: number;
  untilDismissed?: boolean;
}
const tripEnded: Notice = { id: 1, untilDismissed: true };
const reportSaved: Notice = { id: 2 };
const voteSaved: Notice = { id: 3 };

describe('map notice slots', () => {
  it('keeps a notice that stays until dismissed when a transient one arrives', () => {
    const slots = showNoticeInSlots(showNoticeInSlots<Notice>({}, tripEnded), reportSaved);
    expect(visibleNotice(slots)).toBe(tripEnded);
    // The transient one is dropped when its time runs out, never shown over the other.
    expect(visibleNotice(dismissNotice(slots, reportSaved.id))).toBe(tripEnded);
  });

  it('shows transient notices once the persistent one is dismissed', () => {
    const slots = showNoticeInSlots(showNoticeInSlots<Notice>({}, tripEnded), reportSaved);
    expect(visibleNotice(dismissNotice(slots, tripEnded.id))).toBe(reportSaved);
  });

  it('lets a transient notice replace another transient one (the iOS and usual case)', () => {
    const slots = showNoticeInSlots(showNoticeInSlots<Notice>({}, reportSaved), voteSaved);
    expect(visibleNotice(slots)).toBe(voteSaved);
    expect(visibleNotice(dismissNotice(slots, voteSaved.id))).toBeUndefined();
  });

  it('ignores the timeout of a notice already replaced', () => {
    const slots = showNoticeInSlots(showNoticeInSlots<Notice>({}, reportSaved), voteSaved);
    expect(visibleNotice(dismissNotice(slots, reportSaved.id))).toBe(voteSaved);
  });
});
