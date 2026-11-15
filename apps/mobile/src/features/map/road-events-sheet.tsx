import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import {
  isProvincialSnapshot,
  legacyRoadEventSourceLines,
  type MapRoadEvent,
  roadEventAgeLabel,
  roadEventAvailability,
  roadEventConfidenceLabel,
  roadEventSourceLines,
  roadEventSourceName,
  type RoadEventSnapshot,
  roadEventTypeLabel,
} from '@/features/map/road-events';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Banner } from '@/ui/banner';
import type { SymbolName } from '@/ui/button';
import { ListRow } from '@/ui/list-row';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

/** Rows rendered at once; the map keeps every event. */
const LIST_LIMIT = 100;

const TYPE_ICONS: Readonly<Record<MapRoadEvent['type'], SymbolName>> = {
  closure: { android: 'block', ios: 'nosign' },
  collision: { android: 'car_crash', ios: 'car.2.fill' },
  construction: { android: 'construction', ios: 'cone.fill' },
  hazard: { android: 'warning', ios: 'exclamationmark.triangle.fill' },
  incident: { android: 'warning', ios: 'exclamationmark.triangle.fill' },
  'road-condition': { android: 'ac_unit', ios: 'snowflake' },
  'special-event': { android: 'flag', ios: 'flag.fill' },
  'stalled-vehicle': { android: 'directions_car', ios: 'car.fill' },
};

/**
 * The official road events in effect around the driver, newest first, with how long ago each
 * source last changed them and the state of every source. A parked or passenger task: the list
 * is reached from the road-events line on the map, never pushed during guidance.
 */
export function RoadEventsSheet({
  events,
  metrics,
  onClose,
  onClosed,
  onOpenLink,
  onSelect,
  refreshDelayed,
  snapshot,
  visible,
}: {
  events: readonly MapRoadEvent[];
  metrics: ScreenMetrics;
  onClose: () => void;
  onClosed: () => void;
  onOpenLink: (url: string) => void;
  onSelect: (event: MapRoadEvent) => void;
  refreshDelayed: boolean;
  snapshot: RoadEventSnapshot | undefined;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const now = Date.now();
  const shown = events.slice(0, LIST_LIMIT);
  // A held snapshot whose sources have all aged out is unavailable, exactly like no snapshot.
  const available = snapshot !== undefined && roadEventAvailability(snapshot, now) === 'available';
  const sourceLines = isProvincialSnapshot(snapshot)
    ? roadEventSourceLines(snapshot, now)
    : snapshot === undefined
      ? []
      : legacyRoadEventSourceLines(snapshot);

  return (
    <ModalSheet
      accessibilityLabel="Road events"
      detents={[fullSheetHeight(metrics)]}
      onClose={onClose}
      onClosed={onClosed}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Close road events"
        onClose={onClose}
        subtitle="Newest first. Routes do not avoid them."
        title="Road events"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {!available && (snapshot !== undefined || refreshDelayed) && (
          <Banner
            message="Official road-event data could not be loaded. NavOSS tries again every five minutes."
            title="Road events unavailable"
            tone="warning"
          />
        )}
        {snapshot === undefined ? (
          refreshDelayed ? null : (
            <StateView title="Loading road events" visual="loading" />
          )
        ) : (
          <>
            {available && refreshDelayed && (
              <Banner
                message="The latest refresh failed. These are the last events received; each shows when its source last changed it."
                title="Refresh delayed"
                tone="warning"
              />
            )}
            <View style={styles.section}>
              <SectionTitle>Sources</SectionTitle>
              <View style={styles.card}>
                {sourceLines.map((line) => (
                  <View key={line.sourceId} style={styles.sourceRow}>
                    <Text
                      maxFontSizeMultiplier={1.5}
                      style={[styles.sourceLine, line.tone === 'warning' && styles.sourceWarning]}
                    >
                      {line.text}
                    </Text>
                    <Text maxFontSizeMultiplier={1.5} style={styles.attribution}>
                      {line.attribution}
                    </Text>
                    <Pressable
                      accessibilityLabel={`Licence for ${line.text.split(' · ')[0] ?? 'this source'}`}
                      accessibilityRole="link"
                      hitSlop={12}
                      onPress={() => {
                        onOpenLink(line.licenseUrl);
                      }}
                      style={styles.licenceLink}
                    >
                      <Text maxFontSizeMultiplier={1.5} style={styles.licenceText}>
                        Licence
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
            {available && (
              <View style={styles.section}>
                <SectionTitle>{`In effect now · ${String(events.length)}`}</SectionTitle>
                {events.length === 0 ? (
                  <View style={styles.card}>
                    <StateView
                      message="The sources above report nothing in effect here right now."
                      title="No road events"
                      visual={{ android: 'check_circle', ios: 'checkmark.circle' }}
                    />
                  </View>
                ) : (
                  <View style={styles.card}>
                    {shown.map((event, index) => {
                      const age = roadEventAgeLabel(event, now);
                      const source = roadEventSourceName(event, snapshot);
                      const subtitle = [age, source]
                        .filter((part) => part !== undefined)
                        .join(' · ');
                      return (
                        <View key={event.id}>
                          {index > 0 && <View style={styles.divider} />}
                          <ListRow
                            accessibilityHint="Shows the source's description"
                            accessibilityLabel={`${event.title}. ${roadEventConfidenceLabel(event)}. ${subtitle}`}
                            accessibilityRole="button"
                            eyebrow={`${roadEventTypeLabel(event)} · ${roadEventConfidenceLabel(event)}`}
                            icon={TYPE_ICONS[event.type]}
                            iconTint={
                              event.confidence === 'official'
                                ? colors.primaryText
                                : colors.warningText
                            }
                            onPress={() => {
                              onSelect(event);
                            }}
                            subtitle={subtitle}
                            title={event.title}
                            titleLines={3}
                            trailing="chevron"
                          />
                        </View>
                      );
                    })}
                  </View>
                )}
                {events.length > shown.length && (
                  <Text maxFontSizeMultiplier={1.5} style={styles.hint}>
                    {`Showing the ${String(shown.length)} newest. The map shows all ${String(events.length)}.`}
                  </Text>
                )}
              </View>
            )}
          </>
        )}
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      paddingHorizontal: space.lg,
      paddingVertical: space.xs,
    },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
    hint: { ...typography.footnote, color: colors.textTertiary },
    section: { gap: space.sm },
    attribution: { ...typography.footnote, color: colors.textTertiary },
    licenceLink: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
    licenceText: { ...typography.footnote, color: colors.primaryText },
    sourceLine: { ...typography.footnote, color: colors.textSecondary },
    sourceRow: { gap: 2, paddingTop: space.sm },
    sourceWarning: { color: colors.warningText },
  }),
);
