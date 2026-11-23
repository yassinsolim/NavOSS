import { StyleSheet, Text, View } from 'react-native';

import { createThemedStyles, radius, space, typography } from '@/theme';
import { Button } from '@/ui/button';

import type { AppUpdates, UpdatePhase } from './app-updates';
import { downloadProgressLabel, formatMegabytes } from './update-copy';

/** Title, message, progress and actions for every state of an offered update. */
export function UpdateCard({
  phase,
  showLater,
  updater,
}: {
  phase: Exclude<UpdatePhase, { kind: 'checking' } | { kind: 'idle' }>;
  /** The map notice offers "Later"; settings does not need it. */
  showLater: boolean;
  updater: AppUpdates;
}) {
  const styles = useStyles();
  const { update } = phase;
  const size = formatMegabytes(update.sizeBytes);
  const later = showLater ? (
    <Button
      label="Later"
      onPress={() => {
        void updater.later();
      }}
      size="sm"
      variant="ghost"
    />
  ) : null;

  let title: string;
  let message: string;
  let actions;
  let progress: number | undefined;
  switch (phase.kind) {
    case 'available':
      title = `NavOSS ${update.versionName} is available`;
      message = `The download is ${size}. You can keep using NavOSS while it downloads.`;
      actions = (
        <>
          {later}
          <Button
            accessibilityLabel={`Install NavOSS ${update.versionName}, ${size} download`}
            label="Install"
            onPress={() => {
              void updater.install();
            }}
            size="sm"
          />
        </>
      );
      break;
    case 'downloading':
      title = `Downloading NavOSS ${update.versionName}`;
      message = downloadProgressLabel(phase.received, phase.total);
      progress = phase.total > 0 ? Math.min(1, phase.received / phase.total) : 0;
      actions = (
        <Button
          label="Cancel download"
          onPress={updater.cancelDownload}
          size="sm"
          variant="secondary"
        />
      );
      break;
    case 'installing':
      title = `Installing NavOSS ${update.versionName}`;
      message =
        'NavOSS checked the download. Confirm the update in the Android prompt; NavOSS closes while it installs.';
      break;
    case 'needs-permission':
      title = 'Allow NavOSS to install updates';
      message =
        'Android asks once. Turn on “Allow from this source” for NavOSS, then come back here.';
      actions = (
        <>
          {later}
          <Button label="Open settings" onPress={updater.openInstallPermissionSettings} size="sm" />
        </>
      );
      break;
    case 'failed':
      title = `NavOSS ${update.versionName} wasn’t installed`;
      message = phase.message;
      actions = (
        <>
          {later}
          <Button
            label="Try again"
            onPress={() => {
              void updater.install();
            }}
            size="sm"
          />
        </>
      );
      break;
  }

  return (
    <View accessibilityLiveRegion="polite" style={styles.card}>
      <Text maxFontSizeMultiplier={1.5} style={styles.title}>
        {title}
      </Text>
      <Text maxFontSizeMultiplier={1.5} style={styles.message}>
        {message}
      </Text>
      {progress !== undefined && (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ max: 100, min: 0, now: Math.round(progress * 100) }}
          style={styles.track}
        >
          <View
            style={[styles.fill, { width: `${Math.round(progress * 100)}%` as `${number}%` }]}
          />
        </View>
      )}
      {actions !== undefined && <View style={styles.actions}>{actions}</View>}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    actions: { flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end' },
    card: { gap: space.sm },
    fill: { backgroundColor: colors.primary, borderRadius: radius.pill, height: '100%' },
    message: { ...typography.footnote, color: colors.textSecondary },
    title: { ...typography.bodyStrong, color: colors.text },
    track: {
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.pill,
      height: 6,
      overflow: 'hidden',
    },
  }),
);
