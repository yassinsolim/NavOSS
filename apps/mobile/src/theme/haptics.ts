import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

function run(effect: () => Promise<void>): void {
  if (Platform.OS === 'web') return;
  // Haptics are a courtesy: a device without a Taptic Engine must never surface an error.
  void effect().catch(() => undefined);
}

/** Haptic vocabulary. Confirmations only; nothing fires for passive state changes. */
export const haptics = {
  /** A destructive or failed outcome the driver should notice. */
  error(): void {
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
  },
  /** A sheet settling on a detent or a primary press. */
  impact(): void {
    run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },
  /** Choosing between options: chips, segments, route alternatives. */
  selection(): void {
    run(() => Haptics.selectionAsync());
  },
  /** A committed action succeeded: navigation started, place saved, report recorded. */
  success(): void {
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  warning(): void {
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  },
} as const;
