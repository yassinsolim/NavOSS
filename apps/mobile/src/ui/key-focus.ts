import { createContext, use, useEffect, useRef } from 'react';
import { findNodeHandle, Platform, type View } from 'react-native';

import { NavOSSInput } from '../../modules/navoss-input';
import { createValueStore, useStoreValue } from '@/lib/value-store';
import { focusRingVisible, keyFocusRequested } from '@/ui/focus';

/** Lets a sheet finish rising before focus moves into it, so the ring lands where it settles. */
const KEY_FOCUS_DELAY_MS = 250;

/** How many modal sheets are open (Android draws focus rings on the top one only). */
export const openModalSheets = createValueStore(0);

/** The number of modal sheets a control sits in; 0 on the screen itself. */
export const ModalLayerContext = createContext(0);

/**
 * Gives the returned ref's control keyboard focus when it mounts with `focusKey` or the key
 * changes (Android, only while the driver uses keys: a touch never shows a ring). A sheet passes
 * a key for what it shows, so the first press after it opens or changes acts on its main control
 * instead of a map button.
 */
export function useKeyFocus<T extends View>(focusKey: string | undefined) {
  const ref = useRef<T>(null);
  const lastKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focusKey === undefined) {
      lastKey.current = undefined;
      return;
    }
    if (!keyFocusRequested(Platform.OS, lastKey.current, focusKey) || NavOSSInput === null) return;
    // The key counts as served when focus is asked for, not when the effect runs: a cancelled
    // timer (the sheet closed at once, or a development double render) asks again next time.
    const timer = setTimeout(() => {
      lastKey.current = focusKey;
      const tag = ref.current === null ? null : findNodeHandle(ref.current);
      if (tag !== null) NavOSSInput?.focusForKeys(tag).catch(() => undefined);
    }, KEY_FOCUS_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [focusKey]);
  return ref;
}

/** Whether a focused control draws its ring here, given the modal sheets open above it. */
export function useRingVisible(focused: boolean): boolean {
  const layer = use(ModalLayerContext);
  const openModals = useStoreValue(openModalSheets);
  return focusRingVisible({ focused, layer, openModals });
}
