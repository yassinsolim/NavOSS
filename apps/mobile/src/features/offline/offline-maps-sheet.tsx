import { useEffect } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import {
  formatBytes,
  offlineCatalogNotice,
  type RegionAction,
  regionActions,
  regionFailureMessage,
  regionProgress,
  regionStatusText,
} from '@/features/offline/offline-copy';
import {
  deleteOfflineRegion,
  downloadOfflineRegion,
  type NativeOfflineRegion,
  pauseOfflineRegion,
  refreshOfflineManifest,
  setPreferOfflineMaps,
  useOfflineState,
} from '@/features/offline/offline-maps';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import { Banner } from '@/ui/banner';
import { Button } from '@/ui/button';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

const ACTION_LABELS: Readonly<Record<RegionAction, string>> = {
  cancel: 'Cancel',
  delete: 'Delete',
  download: 'Download',
  pause: 'Pause',
  resume: 'Resume',
  update: 'Update',
};

function RegionRow({ canDownload, region }: { canDownload: boolean; region: NativeOfflineRegion }) {
  const styles = useStyles();
  const progress = regionProgress(region);
  const failure = regionFailureMessage(region);
  const actions = regionActions(region, canDownload);

  const perform = (action: RegionAction) => {
    haptics.selection();
    switch (action) {
      case 'download':
      case 'resume':
      case 'update':
        downloadOfflineRegion(region.id);
        return;
      case 'pause':
        pauseOfflineRegion(region.id);
        return;
      case 'cancel':
        deleteOfflineRegion(region.id);
        return;
      case 'delete':
        Alert.alert(
          `Delete ${region.name}?`,
          `This frees ${formatBytes(region.installedBytes ?? 0)}. Offline maps, search and routes for this region stop working until you download it again.`,
          [
            { style: 'cancel', text: 'Keep' },
            {
              onPress: () => {
                deleteOfflineRegion(region.id);
              },
              style: 'destructive',
              text: 'Delete',
            },
          ],
        );
    }
  };

  return (
    <View
      accessibilityLabel={`${region.name}, ${regionStatusText(region)}${failure === undefined ? '' : `, ${failure}`}`}
      style={styles.region}
    >
      <View accessible style={styles.regionCopy}>
        <Text maxFontSizeMultiplier={1.5} style={styles.regionName}>
          {region.name}
        </Text>
        <Text
          maxFontSizeMultiplier={1.5}
          style={[styles.regionStatus, region.updateAvailable && styles.regionUpdate]}
        >
          {regionStatusText(region)}
        </Text>
        {failure !== undefined && (
          <Text maxFontSizeMultiplier={1.5} style={styles.regionFailure}>
            {failure}
          </Text>
        )}
      </View>
      {progress !== undefined && (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ max: 100, min: 0, now: Math.round(progress * 100) }}
          style={styles.progressTrack}
        >
          <View style={[styles.progressFill, { width: `${Math.round(progress * 1000) / 10}%` }]} />
        </View>
      )}
      {actions.length > 0 && (
        <View style={styles.actions}>
          {actions.map((action, index) => (
            <Button
              accessibilityLabel={`${ACTION_LABELS[action]} ${region.name}`}
              key={action}
              label={ACTION_LABELS[action]}
              onPress={() => {
                perform(action);
              }}
              size="sm"
              variant={action === 'delete' ? 'dangerTonal' : index === 0 ? 'primary' : 'secondary'}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Offline maps: download regions for maps, place search and driving routes without a
 * connection. Downloads are verified before use and stored only on this device.
 */
export function OfflineMapsSheet({
  metrics,
  onClose,
  visible,
}: {
  metrics: ScreenMetrics;
  onClose: () => void;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const state = useOfflineState();
  const notice = offlineCatalogNotice(state);
  const canDownload = state.catalog === 'available' && !state.stale;
  const attributions = [
    ...new Map(
      state.regions.flatMap((region) => region.attribution).map((item) => [item.text, item]),
    ).values(),
  ];

  useEffect(() => {
    if (visible) void refreshOfflineManifest().catch(() => undefined);
  }, [visible]);

  const togglePreferOffline = () => {
    haptics.selection();
    setPreferOfflineMaps(!state.preferOffline);
  };

  return (
    <ModalSheet
      accessibilityLabel="Offline maps"
      detents={[fullSheetHeight(metrics)]}
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Close offline maps"
        onClose={onClose}
        subtitle="Maps, place search and driving routes without a connection."
        title="Offline maps"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {notice !== undefined && (
          <Banner announce message={notice.message} title={notice.title} tone={notice.tone} />
        )}
        {!state.networkAvailable && (
          <Banner
            announce
            message="Downloaded regions are in use. Routes have no live traffic or closures."
            title="No connection"
            tone="warning"
          />
        )}

        <View style={styles.section}>
          <SectionTitle>Regions</SectionTitle>
          <View style={styles.card}>
            {state.catalog === 'loading' && state.regions.length === 0 ? (
              <StateView title="Checking for offline maps" visual="loading" />
            ) : state.regions.length === 0 ? (
              <StateView
                message="Regions you can download will appear here."
                title="No regions to show"
                visual={{ android: 'map', ios: 'map' }}
              />
            ) : (
              state.regions.map((region, index) => (
                <View key={region.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <RegionRow canDownload={canDownload} region={region} />
                </View>
              ))
            )}
          </View>
          <Text maxFontSizeMultiplier={1.5} style={styles.hint}>
            {`Offline maps use ${formatBytes(state.storageBytes)}${
              state.availableBytes === undefined
                ? ''
                : ` · ${formatBytes(state.availableBytes)} free on this iPhone`
            }. Downloads use mobile data when Wi-Fi is off, and pause if NavOSS is closed.`}
          </Text>
        </View>

        <View style={styles.section}>
          <SectionTitle>Map</SectionTitle>
          <Pressable
            accessibilityHint="Uses downloaded maps inside your regions even with a connection."
            accessibilityLabel="Prefer offline maps"
            accessibilityRole="switch"
            accessibilityState={{ checked: state.preferOffline }}
            onPress={togglePreferOffline}
            style={[styles.card, styles.switchRow]}
          >
            <View style={styles.switchCopy}>
              <Text style={styles.switchLabel}>Prefer offline maps</Text>
              <Text style={styles.switchDetail}>
                Draw downloaded maps inside your regions even with a connection. Without a
                connection they are used automatically.
              </Text>
            </View>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Switch
                onValueChange={togglePreferOffline}
                trackColor={{ false: colors.borderStrong, true: colors.primary }}
                value={state.preferOffline}
              />
            </View>
          </Pressable>
        </View>

        <View style={styles.section}>
          <SectionTitle>What works offline</SectionTitle>
          <Text maxFontSizeMultiplier={1.5} style={styles.body}>
            Inside a downloaded region: the map, OpenStreetMap place and address search, and driving
            routes with rerouting. A trip has to start and end inside one downloaded region.
          </Text>
          <Text maxFontSizeMultiplier={1.5} style={styles.body}>
            Offline routes have no live traffic, road closures or community reports, and are
            labelled “Offline route”. NavOSS switches back to online routing as soon as the service
            answers again.
          </Text>
        </View>

        {attributions.length > 0 && (
          <View style={styles.section}>
            <SectionTitle>Data</SectionTitle>
            {attributions.map((item) => (
              <Text key={item.text} maxFontSizeMultiplier={1.5} style={styles.hint}>
                {`${item.text} (${item.license})`}
              </Text>
            ))}
          </View>
        )}
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    body: { ...typography.body, color: colors.textSecondary },
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      paddingHorizontal: space.lg,
    },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
    hint: { ...typography.footnote, color: colors.textTertiary },
    progressFill: { backgroundColor: colors.primary, borderRadius: radius.pill, height: '100%' },
    progressTrack: {
      backgroundColor: colors.border,
      borderRadius: radius.pill,
      height: 6,
      overflow: 'hidden',
    },
    region: { gap: space.sm, paddingVertical: space.md },
    regionCopy: { gap: 2 },
    regionFailure: { ...typography.footnote, color: colors.dangerText },
    regionName: { ...typography.bodyStrong, color: colors.text },
    regionStatus: { ...typography.footnote, color: colors.textSecondary },
    regionUpdate: { color: colors.primaryText },
    section: { gap: space.sm },
    switchCopy: { flex: 1, gap: 2, paddingRight: space.md },
    switchDetail: { ...typography.footnote, color: colors.textSecondary },
    switchLabel: { ...typography.bodyStrong, color: colors.text },
    switchRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingVertical: space.md,
    },
  }),
);
