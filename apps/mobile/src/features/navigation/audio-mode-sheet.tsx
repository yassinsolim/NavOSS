import { SymbolView } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NavigationAudioMode } from '@/features/navigation/native-navigation';
import { createThemedStyles, space, useTheme } from '@/theme';
import type { SymbolName } from '@/ui/button';
import { ListRow } from '@/ui/list-row';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';

export const AUDIO_MODES: readonly {
  detail: string;
  icon: SymbolName;
  label: string;
  mode: NavigationAudioMode;
}[] = [
  {
    detail: 'Maneuvers and safety alerts',
    icon: { android: 'volume_up', ios: 'speaker.wave.2.fill' },
    label: 'All guidance',
    mode: 'all-guidance',
  },
  {
    detail: 'Safety alerts, no maneuvers',
    icon: { android: 'notifications', ios: 'bell.fill' },
    label: 'Alerts only',
    mode: 'alerts-only',
  },
  {
    detail: 'No spoken guidance',
    icon: { android: 'volume_off', ios: 'speaker.slash.fill' },
    label: 'Muted',
    mode: 'muted',
  },
];

export function audioModeOption(mode: NavigationAudioMode) {
  return AUDIO_MODES.find((option) => option.mode === mode) ?? AUDIO_MODES[0];
}

/** Chooses what NavOSS speaks during navigation. Shared with CarPlay through the native core. */
export function AudioModeSheet({
  mode,
  onChoose,
  onClose,
  visible,
}: {
  mode: NavigationAudioMode;
  onChoose: (mode: NavigationAudioMode) => void;
  onClose: () => void;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <ModalSheet
      accessibilityLabel="Guidance sound"
      detents={['content']}
      onClose={onClose}
      visible={visible}
    >
      <View style={{ paddingBottom: Math.max(insets.bottom, space.lg) }}>
        <SheetHeader
          closeLabel="Close guidance sound"
          onClose={onClose}
          subtitle="Choose what NavOSS speaks during navigation."
          title="Guidance sound"
        />
        <View accessibilityRole="radiogroup" style={styles.options}>
          {AUDIO_MODES.map((option) => {
            const selected = option.mode === mode;
            return (
              <ListRow
                accessibilityLabel={`${option.label}, ${option.detail}${selected ? ', selected' : ''}`}
                accessibilityRole="radio"
                icon={option.icon}
                key={option.mode}
                onPress={() => {
                  onChoose(option.mode);
                }}
                subtitle={option.detail}
                title={option.label}
                trailing={
                  selected ? (
                    <SymbolView
                      name={{ android: 'check', ios: 'checkmark' }}
                      size={18}
                      tintColor={colors.primaryText}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </View>
      </View>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(() =>
  StyleSheet.create({
    options: { paddingHorizontal: space.sm },
  }),
);
