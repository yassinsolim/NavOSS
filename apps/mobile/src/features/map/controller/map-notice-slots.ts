/**
 * The map's notices in two slots. A notice that stays until dismissed (Android's "Trip ended")
 * has its own slot, so a transient notice shown later (a road report saved, a vote) cannot
 * replace it; it is visible again once the driver dismisses the persistent one, if its time has
 * not run out. Transient notices replace each other as before. iOS shows no persistent notice,
 * so it behaves exactly as with one slot.
 */
export interface NoticeSlots<Notice> {
  persistent?: Notice;
  transient?: Notice;
}

interface SlottedNotice {
  id: number;
  untilDismissed?: boolean;
}

export function showNoticeInSlots<Notice extends SlottedNotice>(
  slots: NoticeSlots<Notice>,
  notice: Notice,
): NoticeSlots<Notice> {
  return notice.untilDismissed === true
    ? { ...slots, persistent: notice }
    : { ...slots, transient: notice };
}

/** Removes the notice with `id` (dismissed, or its time ran out); any other is kept. */
export function dismissNotice<Notice extends SlottedNotice>(
  slots: NoticeSlots<Notice>,
  id: number,
): NoticeSlots<Notice> {
  return {
    ...(slots.persistent !== undefined && slots.persistent.id !== id
      ? { persistent: slots.persistent }
      : {}),
    ...(slots.transient !== undefined && slots.transient.id !== id
      ? { transient: slots.transient }
      : {}),
  };
}

export function visibleNotice<Notice>(slots: NoticeSlots<Notice>): Notice | undefined {
  return slots.persistent ?? slots.transient;
}
