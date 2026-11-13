import type {
  RouteAlternativeV2,
  RoutePreferences,
  RouteResponseV2,
  SearchResult,
} from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { routePreviewSheetDetents, type ScreenMetrics } from '@/features/map/overlay-layout';
import {
  formatArrivalTime,
  formatDistance,
  formatDuration,
  formatTrafficDelay,
  routeTrafficLabel,
  routeViaLabel,
} from '@/features/navigation/route-progress';
import type { VehicleStyle } from '@/features/navigation/vehicle-puck';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Banner } from '@/ui/banner';
import { Button } from '@/ui/button';
import { Chip } from '@/ui/chip';
import { ListRow } from '@/ui/list-row';
import { PressableScale } from '@/ui/pressable-scale';
import { type SegmentOption, SegmentedControl } from '@/ui/segmented-control';
import { BottomSheet, BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

interface RoutePlanningSheetProps {
  bottomInset: number;
  destination: SearchResult;
  errorMessage?: string;
  onCancel: () => void;
  onPreviewSupportedRoute: () => void;
  onRetry: () => void;
  position: SharedValue<number>;
}

/** Shown while a route is being calculated, and when it could not be. */
export function RoutePlanningSheet({
  bottomInset,
  destination,
  errorMessage,
  onCancel,
  onPreviewSupportedRoute,
  onRetry,
  position,
}: RoutePlanningSheetProps) {
  const styles = useStyles();
  const failed = errorMessage !== undefined;

  return (
    <BottomSheet accessibilityLabel="Route planning" detents={['content']} position={position}>
      <View style={{ paddingBottom: Math.max(bottomInset, space.lg) }}>
        <SheetHeader
          closeLabel="Cancel route"
          eyebrow={failed ? 'Route unavailable' : 'Finding the best route'}
          onClose={onCancel}
          title={destination.name}
        />
        {failed ? (
          <View style={styles.planningBody}>
            <Banner announce message={errorMessage} tone="danger" />
            <View style={styles.planningActions}>
              <Button
                accessibilityLabel="Retry route"
                icon={{ android: 'refresh', ios: 'arrow.clockwise' }}
                label="Retry"
                onPress={onRetry}
              />
              <Button
                accessibilityHint="Plans this trip from Calgary Tower so you can see the route. It cannot be started."
                icon={{ android: 'map', ios: 'map.fill' }}
                label="Preview a supported route"
                onPress={onPreviewSupportedRoute}
                variant="tonal"
              />
            </View>
          </View>
        ) : (
          <StateView
            style={styles.planningState}
            title="Finding a route to your destination"
            visual="loading"
          />
        )}
      </View>
    </BottomSheet>
  );
}

function RouteChoiceCard({
  onSelect,
  route,
  selected,
}: {
  onSelect: () => void;
  route: RouteAlternativeV2;
  selected: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const trafficDelay = formatTrafficDelay(route.traffic?.delaySeconds ?? 0);
  const viaLabel = routeViaLabel(route);
  const detail = `${route.label === 'fastest' ? 'Fastest · ' : ''}${formatDistance(route.distanceMeters)}${trafficDelay === undefined ? '' : ` · ${trafficDelay}`}`;

  return (
    <PressableScale
      accessibilityLabel={`Select ${route.label} ${formatDuration(route.durationSeconds)} route, ${formatDistance(route.distanceMeters)}, ${viaLabel}${trafficDelay === undefined ? '' : `, ${trafficDelay}`}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onSelect}
      pressedScale={0.98}
      style={[styles.routeChoice, selected && styles.routeChoiceSelected]}
    >
      <View style={styles.routeChoiceHeading}>
        <Text
          maxFontSizeMultiplier={1.3}
          style={[styles.routeChoiceEta, selected && styles.routeChoiceEtaSelected]}
        >
          {formatDuration(route.durationSeconds)}
        </Text>
        {selected && (
          <SymbolView
            name={{ android: 'check_circle', ios: 'checkmark.circle.fill' }}
            size={18}
            tintColor={colors.primaryText}
          />
        )}
      </View>
      <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.routeChoiceMeta}>
        {detail}
      </Text>
      <Text maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.routeChoiceVia}>
        {viaLabel}
      </Text>
    </PressableScale>
  );
}

const AVOIDANCES = [
  ['avoidHighways', 'Highways', { android: 'alt_route', ios: 'road.lanes' }],
  ['avoidTolls', 'Tolls', { android: 'toll', ios: 'dollarsign.circle.fill' }],
  ['avoidFerries', 'Ferries', { android: 'directions_boat', ios: 'ferry.fill' }],
  ['avoidUnpaved', 'Unpaved', { android: 'landscape', ios: 'mountain.2.fill' }],
] as const;

const VEHICLE_OPTIONS: readonly SegmentOption<VehicleStyle>[] = [
  { accessibilityLabel: 'Use arrow navigation marker', label: 'Arrow', value: 'arrow' },
  { accessibilityLabel: 'Use car navigation marker', label: 'Car', value: 'car' },
];

interface RoutePreviewSheetProps {
  destination: SearchResult;
  /** Detent to open at. Re-planning remounts this sheet; it reopens where the driver left it. */
  initialDetent?: number;
  metrics: ScreenMetrics;
  onCancel: () => void;
  onDetentChange?: (index: number) => void;
  onEditStops: () => void;
  onSelectRoute: (route: RouteAlternativeV2) => void;
  onStart: () => void;
  onToggleRoutePreference: (preference: keyof RoutePreferences) => void;
  onUseCurrentLocation: () => void;
  onVehicleStyleChange: (vehicleStyle: VehicleStyle) => void;
  position: SharedValue<number>;
  /** Set when the route was planned from a fixed demo origin rather than the driver's location. */
  previewOriginLabel?: string;
  routePreferences: RoutePreferences;
  routeSource?: RouteResponseV2['source'];
  routes: RouteAlternativeV2[];
  selectedRoute: RouteAlternativeV2;
  vehicleStyle: VehicleStyle;
  waypoints: SearchResult[];
}

/**
 * Route preview. The lowest detent is the decision (arrival, distance, Start); the detent it
 * opens to adds the alternatives and stops; dragging further reveals avoidances and the
 * navigation marker. Traffic is stated as it is (`routeTrafficLabel`): "No live traffic" unless
 * the routing source provides it, and community traffic credited to its drivers only on a route
 * it observed.
 */
export function RoutePreviewSheet({
  destination,
  initialDetent,
  metrics,
  onCancel,
  onDetentChange,
  onEditStops,
  onSelectRoute,
  onStart,
  onToggleRoutePreference,
  onUseCurrentLocation,
  onVehicleStyleChange,
  position,
  previewOriginLabel,
  routePreferences,
  routeSource,
  routes,
  selectedRoute,
  vehicleStyle,
  waypoints,
}: RoutePreviewSheetProps) {
  const styles = useStyles();
  const demoOrigin = previewOriginLabel !== undefined;
  const detents = routePreviewSheetDetents(metrics, { demoOrigin });
  const trafficStatus = routeTrafficLabel(routeSource, selectedRoute);

  return (
    <BottomSheet
      accessibilityLabel="Route preview"
      detents={detents.values}
      initialDetent={initialDetent ?? detents.initial}
      onDetentChange={onDetentChange}
      position={position}
    >
      <SheetHeader
        closeLabel="Cancel route"
        eyebrow="Route preview"
        onClose={onCancel}
        title={destination.name}
      />
      <View style={styles.summary}>
        <View style={styles.summaryCopy}>
          <Text
            maxFontSizeMultiplier={1.3}
            adjustsFontSizeToFit
            numberOfLines={1}
            style={styles.eta}
          >
            {formatDuration(selectedRoute.durationSeconds)}
          </Text>
          <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.arrival}>
            {formatDistance(selectedRoute.distanceMeters)} · arrive{' '}
            {formatArrivalTime(selectedRoute.durationSeconds)}
          </Text>
        </View>
        {demoOrigin ? (
          <Button
            accessibilityLabel="Use my location for navigation"
            icon={{ android: 'my_location', ios: 'location.fill' }}
            label="Use my location"
            onPress={onUseCurrentLocation}
            size="driving"
          />
        ) : (
          <Button
            accessibilityLabel="Start navigation"
            icon={{ android: 'navigation', ios: 'location.north.fill' }}
            label="Start"
            onPress={onStart}
            size="driving"
            style={styles.startButton}
          />
        )}
      </View>

      <BottomSheetScrollView
        contentContainerStyle={[
          styles.previewContent,
          { paddingBottom: metrics.bottomInset + space.xl },
        ]}
      >
        {demoOrigin && (
          <View
            accessibilityLabel={`Preview only from ${previewOriginLabel}`}
            accessible
            style={styles.inset}
          >
            <Banner
              message={`Preview only from ${previewOriginLabel}. Live guidance always uses your real location.`}
            />
          </View>
        )}
        <ScrollView
          contentContainerStyle={styles.routeChoices}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {routes.map((route) => (
            <RouteChoiceCard
              key={route.id}
              onSelect={() => {
                onSelectRoute(route);
              }}
              route={route}
              selected={route.id === selectedRoute.id}
            />
          ))}
        </ScrollView>

        <View style={styles.sourceRow}>
          <Text maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.sourceText}>
            {routeSource?.attribution ?? 'Routing source unavailable'}
          </Text>
          <Text maxFontSizeMultiplier={1.3} style={styles.trafficText}>
            {trafficStatus}
          </Text>
        </View>

        <View style={styles.inset}>
          <View style={styles.card}>
            <ListRow
              accessibilityLabel="Edit route stops"
              icon={{
                android: 'alt_route',
                ios: 'point.bottomleft.forward.to.point.topright.scurvepath',
              }}
              onPress={onEditStops}
              title={
                waypoints.length === 0
                  ? 'Add or edit stops'
                  : `${String(waypoints.length)} ${waypoints.length === 1 ? 'stop' : 'stops'} · Edit order`
              }
              trailing="chevron"
            />
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.inset}>
            <SectionTitle>Avoid</SectionTitle>
          </View>
          <ScrollView
            contentContainerStyle={styles.avoidances}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {AVOIDANCES.map(([preference, label, icon]) => (
              <Chip
                accessibilityLabel={`Avoid ${label.toLowerCase()}`}
                accessibilityRole="switch"
                accessibilityState={{ checked: routePreferences[preference] }}
                icon={icon}
                key={preference}
                label={label}
                onPress={() => {
                  onToggleRoutePreference(preference);
                }}
                selected={routePreferences[preference]}
              />
            ))}
          </ScrollView>
        </View>

        <View style={[styles.section, styles.inset]}>
          <SectionTitle>Navigation marker</SectionTitle>
          <SegmentedControl
            accessibilityLabel="Navigation marker"
            onChange={onVehicleStyleChange}
            options={VEHICLE_OPTIONS}
            value={vehicleStyle}
          />
        </View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    arrival: { ...typography.callout, color: colors.textSecondary },
    avoidances: { gap: space.sm, paddingHorizontal: space.lg },
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    eta: { ...typography.largeTitle, color: colors.primaryText, fontVariant: ['tabular-nums'] },
    inset: { marginHorizontal: space.lg },
    planningActions: { gap: space.sm },
    planningBody: { gap: space.lg, paddingHorizontal: space.lg },
    planningState: { paddingHorizontal: space.lg },
    previewContent: { gap: space.lg },
    routeChoice: {
      backgroundColor: colors.surfaceSunken,
      borderColor: 'transparent',
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      borderWidth: 2,
      gap: 2,
      minHeight: 104,
      padding: space.md,
      width: 232,
    },
    routeChoiceEta: { ...typography.title2, color: colors.text, fontVariant: ['tabular-nums'] },
    routeChoiceEtaSelected: { color: colors.primaryText },
    routeChoiceHeading: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    routeChoiceMeta: { ...typography.footnoteStrong, color: colors.text },
    routeChoiceSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
    routeChoiceVia: { ...typography.footnote, color: colors.textSecondary },
    routeChoices: { gap: space.sm, paddingHorizontal: space.lg },
    section: { gap: space.sm },
    sourceRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: space.md,
      justifyContent: 'space-between',
      paddingHorizontal: space.lg,
    },
    sourceText: { ...typography.caption, color: colors.textTertiary, flex: 1 },
    startButton: { minWidth: 148 },
    summary: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: space.md,
      paddingBottom: space.lg,
      paddingHorizontal: space.lg,
    },
    summaryCopy: { flex: 1, gap: 2 },
    trafficText: { ...typography.caption, color: colors.textSecondary },
  }),
);
