import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { createThemedStyles, radius, space, typography } from '@/theme';
import { Button } from '@/ui/button';
import { SwitchRow } from '@/ui/switch-row';

import { UpdateCard } from './update-card';
import { appUpdates, useAppUpdatesState } from './use-app-updates';

/** "App updates" in About (Android only): the switch, Check now and the installed version. */
export function AppUpdatesSection() {
  const styles = useStyles();
  const state = useAppUpdatesState();
  useEffect(() => {
    void appUpdates?.start();
  }, []);
  if (appUpdates === undefined || state === undefined || !state.ready) return null;
  const updater = appUpdates;
  const { installed, lastCheckMessage, phase, preferences } = state;
  const checking = phase.kind === 'checking';
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        App updates
      </Text>
      <Text style={styles.body}>
        NavOSS for Android is installed from GitHub releases. To look for a newer version, the app
        asks GitHub’s releases list for the NavOSS repository: one request, with nothing about you
        or your trips. It never checks during a trip.
      </Text>
      <View style={styles.group}>
        <SwitchRow
          detail="At most once a day, when NavOSS opens"
          label="Check for updates automatically"
          onValueChange={(value) => {
            void updater.setAutoCheck(value);
          }}
          value={preferences.autoCheck}
        />
      </View>
      {phase.kind !== 'idle' && phase.kind !== 'checking' && (
        <View style={styles.group}>
          <UpdateCard phase={phase} showLater={false} updater={updater} />
        </View>
      )}
      {phase.kind !== 'downloading' && phase.kind !== 'installing' && (
        <Button
          disabled={checking}
          label="Check now"
          loading={checking}
          onPress={() => {
            void updater.checkNow();
          }}
          variant="secondary"
        />
      )}
      {lastCheckMessage !== undefined && (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {lastCheckMessage}
        </Text>
      )}
      {installed !== undefined && (
        <Text style={styles.footnote}>
          Installed: version {installed.versionName} (build {String(installed.versionCode)})
        </Text>
      )}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    body: { ...typography.body, color: colors.textSecondary },
    footnote: { ...typography.footnote, color: colors.textSecondary },
    group: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.md,
    },
    section: { gap: space.md },
    sectionTitle: { ...typography.title3, color: colors.text },
  }),
);
