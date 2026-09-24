import type {
  RouteAlternative,
  RoutePreferences,
  RouteResponse,
  SafetyCamera,
  SearchResult,
} from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { Spacing } from '@/constants/theme';
import {
  formatArrivalTime,
  formatDistance,
  formatDuration,
  formatTrafficDelay,
  routeViaLabel,
} from '@/features/navigation/route-progress';
import {
  maneuverDirection,
  type ManeuverDirection,
} from '@/features/navigation/maneuver-direction';
import type { VehicleMatchStatus, VehicleStyle } from '@/features/navigation/vehicle-puck';
import type { NavigationAudioMode } from '@/features/navigation/native-navigation';

// Keep the summary and four 44pt actions on separate rows at portrait-phone widths.
export const NAVIGATION_STATUS_COMPACT_WIDTH = 480;

interface RoutePlanningPanelProps {
  bottomInset: number;
  destination: SearchResult;
  errorMessage?: string;
  onCancel: () => void;
  onPreviewSupportedRoute?: () => void;
  onRetry: () => void;
}

export function RoutePlanningPanel({
  bottomInset,
  destination,
  errorMessage,
  onCancel,
  onPreviewSupportedRoute,
  onRetry,
}: RoutePlanningPanelProps) {
  return (
    <Animated.View
      entering={FadeInUp.duration(240).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(170).reduceMotion(ReduceMotion.System)}
      layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)}
      style={[styles.bottomPanel, { paddingBottom: Math.max(bottomInset, 14) }]}
    >
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleCopy}>
          <Text numberOfLines={1} style={styles.eyebrow}>
            {errorMessage === undefined ? 'Finding the best route' : 'Route unavailable'}
          </Text>
          <Text accessibilityRole="header" numberOfLines={2} style={styles.destinationName}>
            {destination.name}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Cancel route"
          accessibilityRole="button"
          onPress={onCancel}
          style={({ pressed }) => [styles.iconButton, pressed && styles.controlPressed]}
        >
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={19}
            tintColor={NavOssColors.muted}
          />
        </Pressable>
      </View>

      {errorMessage === undefined ? (
        <Animated.View
          accessibilityLiveRegion="polite"
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          style={styles.planningRow}
        >
          <ActivityIndicator color={NavOssColors.green} size="small" />
          <Text style={styles.planningText}>Finding a route to your destination</Text>
        </Animated.View>
      ) : (
        <Animated.View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          style={styles.errorContent}
        >
          <Text style={styles.errorText}>{errorMessage}</Text>
          <View style={styles.errorActions}>
            <Pressable
              accessibilityLabel="Retry route"
              accessibilityRole="button"
              onPress={onRetry}
              style={({ pressed }) => [styles.retryButton, pressed && styles.primaryPressed]}
            >
              <SymbolView
                name={{ android: 'refresh', ios: 'arrow.clockwise' }}
                size={18}
                tintColor={NavOssColors.white}
              />
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
            {onPreviewSupportedRoute !== undefined && (
              <Pressable
                accessibilityLabel="Preview a supported route"
                accessibilityRole="button"
                onPress={onPreviewSupportedRoute}
                style={({ pressed }) => [
                  styles.previewFallbackButton,
                  pressed && styles.controlPressed,
                ]}
              >
                <SymbolView
                  name={{ android: 'map', ios: 'map.fill' }}
                  size={18}
                  tintColor={NavOssColors.green}
                />
                <Text style={styles.previewFallbackText}>Preview a supported route</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}

interface RoutePreviewPanelProps {
  bottomInset: number;
  destination: SearchResult;
  onCancel: () => void;
  onEditStops: () => void;
  onSelectRoute: (route: RouteAlternative) => void;
  onStart: () => void;
  onToggleRoutePreference: (preference: keyof RoutePreferences) => void;
  onUseCurrentLocation: () => void;
  onVehicleStyleChange: (vehicleStyle: VehicleStyle) => void;
  previewOriginLabel?: string;
  routes: RouteAlternative[];
  selectedRoute: RouteAlternative;
  routeSource?: RouteResponse['source'];
  routePreferences: RoutePreferences;
  vehicleStyle: VehicleStyle;
  waypoints: SearchResult[];
}

function RouteChoiceCard({
  onSelect,
  route,
  selected,
}: {
  onSelect: () => void;
  route: RouteAlternative;
  selected: boolean;
}) {
  const trafficDelay = formatTrafficDelay(route.traffic?.delaySeconds ?? 0);
  const viaLabel = routeViaLabel(route);

  return (
    <Animated.View
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      layout={LinearTransition.duration(170).reduceMotion(ReduceMotion.System)}
    >
      <Pressable
        accessibilityLabel={`Select ${route.label} ${formatDuration(route.durationSeconds)} route, ${formatDistance(route.distanceMeters)}, ${viaLabel}${trafficDelay === undefined ? '' : `, ${trafficDelay}`}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onSelect}
        style={({ pressed }) => [
          styles.routeChoice,
          selected && styles.routeChoiceSelected,
          pressed && styles.routeChoicePressed,
        ]}
      >
        <View style={styles.routeChoiceHeading}>
          <Text style={[styles.routeChoiceEta, selected && styles.routeChoiceEtaSelected]}>
            {formatDuration(route.durationSeconds)}
          </Text>
          {selected && (
            <SymbolView
              name={{ android: 'check_circle', ios: 'checkmark.circle.fill' }}
              size={18}
              tintColor={NavOssColors.green}
            />
          )}
        </View>
        <Text style={[styles.routeChoiceMeta, selected && styles.routeChoiceMetaSelected]}>
          {route.label === 'fastest'
            ? `Fastest · ${formatDistance(route.distanceMeters)}${trafficDelay === undefined ? '' : ` · ${trafficDelay}`}`
            : `${formatDistance(route.distanceMeters)}${trafficDelay === undefined ? '' : ` · ${trafficDelay}`}`}
        </Text>
        <Text
          numberOfLines={2}
          style={[styles.routeVia, selected && styles.routeChoiceMetaSelected]}
        >
          {viaLabel}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export function RoutePreviewPanel({
  bottomInset,
  destination,
  onCancel,
  onEditStops,
  onSelectRoute,
  onStart,
  onToggleRoutePreference,
  onUseCurrentLocation,
  onVehicleStyleChange,
  previewOriginLabel,
  routes,
  selectedRoute,
  routeSource,
  routePreferences,
  vehicleStyle,
  waypoints,
}: RoutePreviewPanelProps) {
  const selectedTrafficDelay = formatTrafficDelay(selectedRoute.traffic?.delaySeconds ?? 0);
  return (
    <Animated.View
      entering={FadeInUp.duration(200).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(180).reduceMotion(ReduceMotion.System)}
      layout={LinearTransition.duration(200).reduceMotion(ReduceMotion.System)}
      style={[
        styles.bottomPanel,
        styles.previewPanel,
        { paddingBottom: Math.max(bottomInset, 12) },
      ]}
    >
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleCopy}>
          <Text style={styles.eyebrow}>Route preview</Text>
          <Text accessibilityRole="header" numberOfLines={2} style={styles.destinationName}>
            {destination.name}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Cancel route"
          accessibilityRole="button"
          onPress={onCancel}
          style={({ pressed }) => [styles.iconButton, pressed && styles.controlPressed]}
        >
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={19}
            tintColor={NavOssColors.muted}
          />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.routeChoices}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {routes.map((route) => {
          const selected = route.id === selectedRoute.id;
          return (
            <RouteChoiceCard
              key={route.id}
              onSelect={() => {
                onSelectRoute(route);
              }}
              route={route}
              selected={selected}
            />
          );
        })}
      </ScrollView>

      <Pressable
        accessibilityLabel="Edit route stops"
        accessibilityRole="button"
        onPress={onEditStops}
        style={({ pressed }) => [styles.stopsButton, pressed && styles.controlPressed]}
      >
        <SymbolView
          name={{
            android: 'alt_route',
            ios: 'point.bottomleft.forward.to.point.topright.scurvepath',
          }}
          size={18}
          tintColor={NavOssColors.green}
        />
        <Text numberOfLines={1} style={styles.stopsButtonText}>
          {waypoints.length === 0
            ? 'Add or edit stops'
            : `${String(waypoints.length)} ${waypoints.length === 1 ? 'stop' : 'stops'} · Edit order`}
        </Text>
        <SymbolView
          name={{ android: 'chevron_right', ios: 'chevron.right' }}
          size={16}
          tintColor={NavOssColors.muted}
        />
      </Pressable>

      <View style={styles.preferenceRow}>
        <Text style={styles.preferenceHeading}>Avoid</Text>

        <ScrollView
          contentContainerStyle={styles.routePreferenceOptions}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.preferenceList}
        >
          {(
            [
              ['avoidHighways', 'Highways', { android: 'alt_route', ios: 'road.lanes' }],
              ['avoidTolls', 'Tolls', { android: 'toll', ios: 'dollarsign.circle.fill' }],
              ['avoidFerries', 'Ferries', { android: 'directions_boat', ios: 'ferry.fill' }],
              ['avoidUnpaved', 'Unpaved', { android: 'landscape', ios: 'mountain.2.fill' }],
            ] as const
          ).map(([preference, label, icon]) => {
            const selected = routePreferences[preference];
            return (
              <Pressable
                accessibilityLabel={`Avoid ${label.toLowerCase()}`}
                accessibilityRole="switch"
                accessibilityState={{ checked: selected }}
                key={preference}
                onPress={() => {
                  onToggleRoutePreference(preference);
                }}
                style={({ pressed }) => [
                  styles.optionButton,
                  selected && styles.optionButtonSelected,
                  pressed && (selected ? styles.primaryPressed : styles.controlPressed),
                ]}
              >
                <SymbolView
                  name={icon}
                  size={17}
                  tintColor={selected ? NavOssColors.white : NavOssColors.asphalt}
                />
                <Text
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                  numberOfLines={1}
                  style={[styles.optionText, selected && styles.optionTextSelected]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.routeOptions}>
        <Text style={styles.markerLabel}>Navigation marker</Text>
        <View accessibilityLabel="Navigation marker" style={styles.vehiclePicker}>
          {(['arrow', 'car'] as const).map((style) => {
            const selected = style === vehicleStyle;
            return (
              <Pressable
                accessibilityLabel={`Use ${style} navigation marker`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={style}
                onPress={() => {
                  onVehicleStyleChange(style);
                }}
                style={({ pressed }) => [
                  styles.vehicleButton,
                  selected && styles.vehicleButtonSelected,
                  pressed && styles.navigationActionPressed,
                ]}
              >
                <SymbolView
                  name={
                    style === 'car'
                      ? { android: 'directions_car', ios: 'car.fill' }
                      : { android: 'navigation', ios: 'location.north.fill' }
                  }
                  size={18}
                  tintColor={selected ? NavOssColors.white : NavOssColors.asphalt}
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.previewSummary}>
        <View style={styles.etaBlock}>
          <Text style={styles.eta}>{formatDuration(selectedRoute.durationSeconds)}</Text>
          <Text style={styles.arrival}>
            {formatDistance(selectedRoute.distanceMeters)} · arrive{' '}
            {formatArrivalTime(selectedRoute.durationSeconds)}
          </Text>
          {selectedTrafficDelay !== undefined && (
            <Text style={styles.trafficStatus}>{selectedTrafficDelay}</Text>
          )}
        </View>
        {previewOriginLabel === undefined ? (
          <Pressable
            accessibilityLabel="Start navigation"
            accessibilityRole="button"
            onPress={onStart}
            style={({ pressed }) => [styles.startButton, pressed && styles.primaryPressed]}
          >
            <SymbolView
              name={{ android: 'navigation', ios: 'location.north.fill' }}
              size={21}
              tintColor={NavOssColors.white}
            />
            <Text style={styles.startText}>Start</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Use my location for navigation"
            accessibilityRole="button"
            onPress={onUseCurrentLocation}
            style={({ pressed }) => [styles.useLocationButton, pressed && styles.primaryPressed]}
          >
            <SymbolView
              name={{ android: 'my_location', ios: 'location.fill' }}
              size={19}
              tintColor={NavOssColors.white}
            />
            <Text style={styles.useLocationText}>Use my location</Text>
          </Pressable>
        )}
      </View>

      {previewOriginLabel !== undefined && (
        <View
          accessibilityLabel={`Preview only from ${previewOriginLabel}`}
          style={styles.previewNotice}
        >
          <SymbolView
            name={{ android: 'info', ios: 'info.circle.fill' }}
            size={16}
            tintColor={NavOssColors.green}
          />
          <Text style={styles.previewNoticeText}>
            Preview only from {previewOriginLabel}. Live guidance always uses your real location.
          </Text>
        </View>
      )}

      <View style={styles.sourceRow}>
        <Text style={styles.developmentSource}>
          {routeSource?.attribution ?? 'Routing source unavailable'}
        </Text>
        <Text style={styles.trafficStatus}>
          {routeSource?.traffic === 'live'
            ? (selectedTrafficDelay ?? 'Live traffic')
            : 'No live traffic'}
        </Text>
      </View>
    </Animated.View>
  );
}

export type NavigationRouteStatus = 'reroute-failed' | 'rerouting' | 'tracking';

interface CarPlayCompanionPanelProps {
  actionLabel: 'Done' | 'End';
  bottomInset: number;
  destinationName: string;
  distanceMeters: number;
  durationSeconds: number;
  instruction: string;
  maneuverType: string;
  onAction: () => void;
  remainingDistanceMeters: number;
  roadName: string;
  safeAreaTop: number;
}

export function CarPlayCompanionPanel({
  actionLabel,
  bottomInset,
  destinationName,
  distanceMeters,
  durationSeconds,
  instruction,
  maneuverType,
  onAction,
  remainingDistanceMeters,
  roadName,
  safeAreaTop,
}: CarPlayCompanionPanelProps) {
  const direction = maneuverDirection(maneuverType, instruction);

  return (
    <Animated.View
      entering={FadeIn.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
      style={[
        styles.carPlayCompanion,
        {
          paddingBottom: Math.max(bottomInset, 20),
          paddingTop: Math.max(safeAreaTop, 20),
        },
      ]}
    >
      <View style={styles.carPlayConnectionRow}>
        <View style={styles.carPlayConnectionDot} />
        <Text style={styles.carPlayConnectionText}>CarPlay</Text>
      </View>

      <View
        accessibilityLabel={`CarPlay navigation, ${formatDistance(distanceMeters)}, ${instruction}${roadName.length === 0 ? '' : `, ${roadName}`}, arrive ${formatArrivalTime(durationSeconds)}`}
        accessibilityLiveRegion="polite"
        accessible
        style={styles.carPlayGuidance}
      >
        <SymbolView name={maneuverSymbol(direction)} size={88} tintColor={NavOssColors.white} />
        <Text
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          numberOfLines={1}
          style={styles.carPlayDistance}
        >
          {formatDistance(distanceMeters)}
        </Text>
        <Text numberOfLines={3} style={styles.carPlayInstruction}>
          {instruction}
        </Text>
        {roadName.length > 0 && (
          <Text numberOfLines={1} style={styles.carPlayRoad}>
            {roadName}
          </Text>
        )}
      </View>

      <View style={styles.carPlayFooter}>
        <View style={styles.carPlayTripSummary}>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            numberOfLines={1}
            style={styles.carPlayEta}
          >
            {formatArrivalTime(durationSeconds)}
          </Text>
          <Text numberOfLines={1} style={styles.carPlayRemaining}>
            {formatDuration(durationSeconds)} · {formatDistance(remainingDistanceMeters)}
          </Text>
          <Text numberOfLines={1} style={styles.carPlayDestination}>
            {destinationName}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={actionLabel === 'End' ? 'End navigation' : 'Finish navigation'}
          accessibilityRole="button"
          onPress={onAction}
          style={({ pressed }) => [
            styles.carPlayEndButton,
            pressed && styles.navigationActionPressed,
          ]}
        >
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={26}
            tintColor={NavOssColors.white}
          />
          <Text style={styles.carPlayEndText}>{actionLabel}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

interface CarPlayIdlePanelProps {
  bottomInset: number;
  safeAreaTop: number;
}

/// Shown whenever CarPlay is connected without active guidance. The phone deliberately renders no
/// map here: the car screen owns the driving surface, and a second MapLibre view on the handset
/// costs battery and GPU for a display the driver should not be looking at.
export function CarPlayIdlePanel({ bottomInset, safeAreaTop }: CarPlayIdlePanelProps) {
  return (
    <Animated.View
      entering={FadeIn.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
      style={[
        styles.carPlayCompanion,
        {
          paddingBottom: Math.max(bottomInset, 20),
          paddingTop: Math.max(safeAreaTop, 20),
        },
      ]}
    >
      <View style={styles.carPlayConnectionRow}>
        <View style={styles.carPlayConnectionDot} />
        <Text style={styles.carPlayConnectionText}>CarPlay</Text>
      </View>

      <View
        accessibilityLabel="NavOSS is running on your car's display. Search and start a route from the car screen."
        accessible
        style={styles.carPlayIdleBody}
      >
        <SymbolView
          name={{ android: 'directions_car', ios: 'car.fill' }}
          size={72}
          tintColor={NavOssColors.sky}
        />
        <Text style={styles.carPlayIdleTitle}>Navigating on your car's display</Text>
        <Text style={styles.carPlayIdleSubtitle}>
          Search and start a route from the car screen.
        </Text>
      </View>
    </Animated.View>
  );
}

interface SafetyCameraAlertBannerProps {
  camera: SafetyCamera;
  distanceAheadMeters: number;
  safeAreaTop: number;
}

export function SafetyCameraAlertBanner({
  camera,
  distanceAheadMeters,
  safeAreaTop,
}: SafetyCameraAlertBannerProps) {
  const distance = formatDistance(distanceAheadMeters);

  return (
    <Animated.View
      accessibilityLabel={`Red light and speed camera ahead, ${distance}, ${camera.location}`}
      accessibilityLiveRegion="polite"
      accessible
      entering={FadeInDown.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(150).reduceMotion(ReduceMotion.System)}
      style={[styles.cameraAlertBanner, { top: safeAreaTop + 136 }]}
    >
      <View style={styles.cameraAlertIcon}>
        <SymbolView
          name={{ android: 'photo_camera', ios: 'camera.fill' }}
          size={23}
          tintColor={NavOssColors.asphalt}
        />
      </View>
      <View style={styles.cameraAlertCopy}>
        <Text style={styles.cameraAlertTitle}>Red light + speed camera</Text>
        <Text numberOfLines={1} style={styles.cameraAlertMeta}>
          {distance} · {camera.location}
        </Text>
      </View>
    </Animated.View>
  );
}

interface NavigationBannerProps {
  distanceMeters: number;
  instruction: string;
  maneuverType: string;
  roadName: string;
  safeAreaTop: number;
  status: NavigationRouteStatus;
}

interface ArrivalPanelProps {
  bottomInset: number;
  destination: SearchResult;
  onDone: () => void;
}

export function ArrivalPanel({ bottomInset, destination, onDone }: ArrivalPanelProps) {
  return (
    <Animated.View
      entering={FadeInUp.duration(260).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(170).reduceMotion(ReduceMotion.System)}
      style={[styles.bottomPanel, { paddingBottom: Math.max(bottomInset, 14) }]}
    >
      <View style={styles.arrivalSummary}>
        <View style={styles.arrivalIcon}>
          <SymbolView
            name={{ android: 'check_circle', ios: 'checkmark.circle.fill' }}
            size={30}
            tintColor={NavOssColors.green}
          />
        </View>
        <View style={styles.panelTitleCopy}>
          <Text style={styles.arrivalTitle}>You've arrived</Text>
          <Text accessibilityRole="header" numberOfLines={2} style={styles.destinationName}>
            {destination.name}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityLabel="Finish navigation"
        accessibilityRole="button"
        onPress={onDone}
        style={({ pressed }) => [styles.doneButton, pressed && styles.primaryPressed]}
      >
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </Animated.View>
  );
}

export function NavigationBanner({
  distanceMeters,
  instruction,
  maneuverType,
  roadName,
  safeAreaTop,
  status,
}: NavigationBannerProps) {
  const direction = maneuverDirection(maneuverType, instruction);
  const displayedInstruction =
    status === 'rerouting'
      ? 'Finding a new route'
      : status === 'reroute-failed'
        ? 'Route update unavailable'
        : instruction;
  const displayedRoadName =
    status === 'rerouting'
      ? 'Using your current location'
      : status === 'reroute-failed'
        ? 'Check your connection'
        : roadName;
  const displayedDistance =
    status === 'rerouting'
      ? 'Rerouting'
      : status === 'reroute-failed'
        ? 'Route paused'
        : formatDistance(distanceMeters);

  return (
    <Animated.View
      accessibilityLabel={`${displayedDistance}, ${displayedInstruction}${displayedRoadName.length === 0 ? '' : `, ${displayedRoadName}`}`}
      accessibilityLiveRegion="polite"
      accessible
      entering={FadeInDown.duration(230).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(160).reduceMotion(ReduceMotion.System)}
      style={[styles.navigationBanner, { top: safeAreaTop + 8 }]}
    >
      <View style={styles.maneuverIcon}>
        <SymbolView
          name={
            status === 'rerouting'
              ? { android: 'sync', ios: 'arrow.triangle.2.circlepath' }
              : status === 'reroute-failed'
                ? { android: 'wifi_off', ios: 'wifi.slash' }
                : maneuverSymbol(direction)
          }
          size={41}
          tintColor={NavOssColors.white}
        />
      </View>
      <View style={styles.guidanceCopy}>
        <Text numberOfLines={1} style={styles.guidanceDistance}>
          {displayedDistance}
        </Text>
        <Text numberOfLines={2} style={styles.guidanceInstruction}>
          {displayedInstruction}
        </Text>
        {displayedRoadName.length > 0 && (
          <Text numberOfLines={1} style={styles.guidanceRoad}>
            {displayedRoadName}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

function maneuverSymbol(direction: ManeuverDirection) {
  switch (direction) {
    case 'arrive':
      return { android: 'flag', ios: 'flag.checkered' } as const;
    case 'left':
      return { android: 'turn_left', ios: 'arrow.turn.up.left' } as const;
    case 'right':
      return { android: 'turn_right', ios: 'arrow.turn.up.right' } as const;
    case 'roundabout':
      return { android: 'roundabout_right', ios: 'arrow.clockwise' } as const;
    case 'uturn':
      return { android: 'u_turn_left', ios: 'arrow.uturn.backward' } as const;
    case 'straight':
      return { android: 'straight', ios: 'arrow.up' } as const;
  }
}

interface NavigationStatusBarProps {
  audioMode: NavigationAudioMode;
  bottomInset: number;
  cameraAnnouncementCount: number;
  distanceMeters: number;
  durationSeconds: number;
  matchStatus: VehicleMatchStatus;
  onEnd: () => void;
  onSound: () => void;
  onReport: () => void;
  onShare: () => void;
  rerouteCount: number;
}

export function NavigationStatusBar({
  audioMode,
  bottomInset,
  cameraAnnouncementCount,
  distanceMeters,
  durationSeconds,
  matchStatus,
  onEnd,
  onSound,
  onReport,
  onShare,
  rerouteCount,
}: NavigationStatusBarProps) {
  const { width } = useWindowDimensions();
  const compact = width < NAVIGATION_STATUS_COMPACT_WIDTH;
  const soundLabel =
    audioMode === 'all-guidance'
      ? 'All guidance'
      : audioMode === 'alerts-only'
        ? 'Alerts only'
        : 'Muted';
  const soundIcon =
    audioMode === 'all-guidance'
      ? ({ android: 'volume_up', ios: 'speaker.wave.2.fill' } as const)
      : audioMode === 'alerts-only'
        ? ({ android: 'notifications', ios: 'bell.fill' } as const)
        : ({ android: 'volume_off', ios: 'speaker.slash.fill' } as const);
  const matchStatusLabel =
    matchStatus === 'matched'
      ? 'on route'
      : matchStatus === 'off-route'
        ? 'off route'
        : 'acquiring route position';
  const rerouteDetail =
    rerouteCount === 0
      ? 'original route'
      : rerouteCount === 1
        ? 'route updated once'
        : `route updated ${String(rerouteCount)} times`;
  const cameraDetail =
    cameraAnnouncementCount === 0
      ? 'no camera alerts announced'
      : cameraAnnouncementCount === 1
        ? 'one camera alert announced'
        : `${String(cameraAnnouncementCount)} camera alerts announced`;

  return (
    <Animated.View
      entering={FadeInUp.duration(250).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(170).reduceMotion(ReduceMotion.System)}
      style={[
        styles.navigationStatus,
        compact && styles.navigationStatusCompact,
        { paddingBottom: Math.max(bottomInset, 10) },
      ]}
    >
      <View
        accessibilityLabel={`Navigation status, ${matchStatusLabel}, ${rerouteDetail}, ${cameraDetail}, arrive ${formatArrivalTime(durationSeconds)}, ${formatDuration(durationSeconds)}, ${formatDistance(distanceMeters)}`}
        accessible
        style={styles.navigationMetrics}
      >
        <View style={styles.navigationMetric}>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            numberOfLines={1}
            style={styles.navigationEta}
          >
            {formatArrivalTime(durationSeconds)}
          </Text>
          <Text style={styles.navigationMeta}>arrival</Text>
        </View>
        <View style={styles.navigationDivider} />
        <View style={styles.navigationMetric}>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            numberOfLines={1}
            style={styles.navigationValue}
          >
            {formatDuration(durationSeconds)}
          </Text>
          <Text style={styles.navigationMeta}>remaining</Text>
        </View>
        <View style={styles.navigationDivider} />
        <View style={styles.navigationMetric}>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            numberOfLines={1}
            style={styles.navigationValue}
          >
            {formatDistance(distanceMeters)}
          </Text>
          <Text style={styles.navigationMeta}>distance</Text>
        </View>
      </View>
      <View style={[styles.navigationActions, compact && styles.navigationActionsCompact]}>
        <Pressable
          accessibilityHint="Choose maneuver and safety-alert speech"
          accessibilityLabel={`Guidance sound, ${soundLabel}`}
          accessibilityRole="button"
          onPress={onSound}
          style={({ pressed }) => [
            styles.navigationAction,
            pressed && styles.navigationActionPressed,
          ]}
        >
          <SymbolView name={soundIcon} size={20} tintColor={NavOssColors.green} />
        </Pressable>
        <Pressable
          accessibilityHint="Choose a road condition to record at your current location"
          accessibilityLabel="Report road condition"
          accessibilityRole="button"
          onPress={onReport}
          style={({ pressed }) => [
            styles.navigationAction,
            styles.reportButton,
            pressed && styles.navigationActionPressed,
          ]}
        >
          <SymbolView
            name={{ android: 'add_alert', ios: 'exclamationmark.bubble.fill' }}
            size={20}
            tintColor={NavOssColors.asphalt}
          />
        </Pressable>
        <Pressable
          accessibilityHint="Opens the system share sheet without reading your contacts"
          accessibilityLabel="Share ETA"
          accessibilityRole="button"
          onPress={onShare}
          style={({ pressed }) => [
            styles.navigationAction,
            styles.shareEtaButton,
            pressed && styles.navigationActionPressed,
          ]}
        >
          <SymbolView
            name={{ android: 'share', ios: 'square.and.arrow.up' }}
            size={20}
            tintColor={NavOssColors.green}
          />
        </Pressable>
        <Pressable
          accessibilityLabel="End navigation"
          accessibilityRole="button"
          onPress={onEnd}
          style={({ pressed }) => [
            styles.navigationAction,
            styles.endButton,
            pressed && styles.navigationActionPressed,
          ]}
        >
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={20}
            tintColor={NavOssColors.coral}
          />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  arrival: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
  },
  arrivalIcon: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  arrivalSummary: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  arrivalTitle: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
  bottomPanel: {
    backgroundColor: NavOssColors.paper,
    borderTopColor: NavOssColors.border,
    borderTopLeftRadius: Spacing.three,
    borderTopRightRadius: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    minHeight: 156,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    position: 'absolute',
    right: 0,
  },
  stopsButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: 8,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
  },
  stopsButtonText: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.semibold,
    fontSize: 15,
    letterSpacing: 0,
  },
  cameraAlertBanner: {
    alignItems: 'center',
    backgroundColor: NavOssColors.paper,
    borderColor: NavOssColors.sun,
    borderRadius: 8,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 10,
    left: 12,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 9,
    position: 'absolute',
    right: 12,
    shadowColor: NavOssColors.asphalt,
    shadowOffset: { height: Spacing.one, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    zIndex: 29,
  },
  cameraAlertCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  cameraAlertIcon: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sun,
    borderRadius: 7,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  cameraAlertMeta: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
  },
  cameraAlertTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 17,
    letterSpacing: 0,
  },
  carPlayCompanion: {
    backgroundColor: NavOssColors.asphalt,
    flex: 1,
    paddingHorizontal: 24,
  },
  carPlayConnectionDot: {
    backgroundColor: NavOssColors.green,
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  carPlayConnectionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 34,
  },
  carPlayConnectionText: {
    color: NavOssColors.sky,
    fontFamily: NavOssFonts.semibold,
    fontSize: 15,
    letterSpacing: 0,
  },
  carPlayDestination: {
    color: NavOssColors.sky,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
    marginTop: 4,
  },
  carPlayDistance: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 54,
    letterSpacing: 0,
    lineHeight: 60,
  },
  carPlayEndButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.coral,
    borderRadius: 8,
    gap: 2,
    height: 68,
    justifyContent: 'center',
    width: 68,
  },
  carPlayEndText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.semibold,
    fontSize: 13,
    letterSpacing: 0,
  },
  carPlayEta: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 27,
    letterSpacing: 0,
  },
  carPlayFooter: {
    alignItems: 'center',
    borderTopColor: 'rgba(255,255,255,0.18)',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 16,
    paddingTop: 18,
  },
  carPlayGuidance: {
    flex: 1,
    gap: 8,
    justifyContent: 'center',
    paddingBottom: 20,
    paddingTop: 12,
  },
  carPlayIdleBody: {
    alignItems: 'center',
    flex: 1,
    gap: 14,
    justifyContent: 'center',
    paddingBottom: 40,
  },
  carPlayIdleSubtitle: {
    color: NavOssColors.sky,
    fontFamily: NavOssFonts.medium,
    fontSize: 16,
    letterSpacing: 0,
    lineHeight: 22,
    textAlign: 'center',
  },
  carPlayIdleTitle: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 26,
    letterSpacing: 0,
    lineHeight: 32,
    textAlign: 'center',
  },
  carPlayInstruction: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 31,
    letterSpacing: 0,
    lineHeight: 37,
  },
  carPlayRemaining: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.medium,
    fontSize: 16,
    letterSpacing: 0,
  },
  carPlayRoad: {
    color: NavOssColors.sky,
    fontFamily: NavOssFonts.medium,
    fontSize: 20,
    letterSpacing: 0,
  },
  carPlayTripSummary: {
    flex: 1,
    minWidth: 0,
  },
  destinationName: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 22,
    letterSpacing: 0,
    lineHeight: 28,
  },
  developmentSource: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
    lineHeight: 16,
    flex: 1,
  },
  doneButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: Spacing.two,
    height: 48,
    justifyContent: 'center',
    marginTop: Spacing.three,
  },
  doneText: {
    color: NavOssColors.paper,
    fontFamily: NavOssFonts.semibold,
    fontSize: 17,
    letterSpacing: 0,
  },
  endButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    justifyContent: 'center',
  },
  controlPressed: {
    backgroundColor: NavOssColors.sky,
  },
  primaryPressed: {
    backgroundColor: NavOssColors.asphalt,
  },
  errorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    marginTop: 14,
  },
  errorActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  errorContent: {
    backgroundColor: NavOssColors.fog,
    borderLeftColor: NavOssColors.coral,
    borderLeftWidth: Spacing.one,
    borderRadius: Spacing.two,
    gap: Spacing.three,
    marginTop: Spacing.three,
    padding: Spacing.three,
  },
  errorText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
    lineHeight: 24,
  },
  eta: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 26,
    letterSpacing: 0,
    lineHeight: 30,
  },
  etaBlock: {
    flex: 1,
    gap: 2,
    minWidth: Spacing.six * 2,
  },
  eyebrow: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.semibold,
    fontSize: 12,
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  guidanceCopy: {
    flex: 1,
    gap: 1,
    minWidth: 0,
  },
  guidanceDistance: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 29,
    letterSpacing: 0,
    lineHeight: 32,
  },
  guidanceInstruction: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 21,
    letterSpacing: 0,
    lineHeight: 25,
  },
  guidanceRoad: {
    color: NavOssColors.sky,
    fontFamily: NavOssFonts.medium,
    fontSize: 15,
    letterSpacing: 0,
  },
  iconButton: {
    alignItems: 'center',
    borderRadius: Spacing.four,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  maneuverIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 8,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  navigationBanner: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 14,
    left: 10,
    minHeight: 116,
    padding: 14,
    position: 'absolute',
    right: 10,
    shadowColor: NavOssColors.asphalt,
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    zIndex: 30,
  },
  navigationEta: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 19,
    letterSpacing: 0,
  },
  navigationAction: {
    alignItems: 'center',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  navigationActionPressed: {
    opacity: 0.8,
  },
  navigationActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  navigationActionsCompact: {
    alignSelf: 'flex-end',
  },
  navigationDivider: {
    alignSelf: 'stretch',
    backgroundColor: NavOssColors.border,
    marginVertical: 4,
    width: StyleSheet.hairlineWidth,
  },
  navigationMeta: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 12,
    letterSpacing: 0,
  },
  navigationMetric: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  navigationMetrics: {
    flex: 1,
    flexDirection: 'row',
    gap: 9,
    minWidth: 0,
  },
  navigationStatus: {
    alignItems: 'center',
    backgroundColor: NavOssColors.paper,
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    left: 0,
    minHeight: 102,
    paddingHorizontal: 12,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
  },
  navigationStatusCompact: {
    alignItems: 'stretch',
    flexDirection: 'column',
    gap: 8,
    minHeight: 154,
    paddingTop: 10,
  },
  navigationValue: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 17,
    letterSpacing: 0,
  },
  optionButton: {
    alignItems: 'center',
    borderColor: NavOssColors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  optionButtonSelected: {
    backgroundColor: NavOssColors.green,
    borderColor: NavOssColors.green,
  },
  optionText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.medium,
    fontSize: 13,
    letterSpacing: 0,
  },
  optionTextSelected: {
    color: NavOssColors.paper,
  },
  preferenceHeading: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
  },
  preferenceList: {
    flex: 1,
  },
  preferenceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  markerLabel: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
  },
  panelHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  panelTitleCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  planningRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  planningText: {
    color: NavOssColors.muted,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
    lineHeight: 24,
  },
  previewPanel: {
    minHeight: 370,
  },
  previewFallbackButton: {
    alignItems: 'center',
    borderColor: NavOssColors.green,
    borderRadius: Spacing.two,
    borderWidth: 1,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  previewFallbackText: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    letterSpacing: 0,
  },
  previewNotice: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  previewNoticeText: {
    color: NavOssColors.muted,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  previewSummary: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  retryButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  retryText: {
    color: NavOssColors.paper,
    fontFamily: NavOssFonts.semibold,
    fontSize: 15,
    letterSpacing: 0,
  },
  routeChoice: {
    borderColor: NavOssColors.border,
    borderRadius: Spacing.two,
    borderWidth: 1,
    gap: Spacing.one,
    minWidth: 160,
    minHeight: 88,
    maxWidth: 224,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  routeChoiceEta: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
  routeChoiceEtaSelected: {
    color: NavOssColors.green,
  },
  routeChoiceHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  routeChoiceMeta: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  routeChoiceMetaSelected: {
    color: NavOssColors.asphalt,
  },
  routeChoicePressed: {
    opacity: 0.78,
  },
  routeChoiceSelected: {
    backgroundColor: NavOssColors.sky,
    borderColor: NavOssColors.green,
  },
  routeChoices: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  routeOptions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  routePreferenceOptions: {
    gap: Spacing.two,
  },
  reportButton: {
    backgroundColor: NavOssColors.sun,
  },
  routeVia: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 20,
    marginTop: Spacing.one,
    maxWidth: 192,
    minHeight: 40,
  },
  shareEtaButton: {
    backgroundColor: NavOssColors.sky,
  },
  sourceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  startButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 52,
    justifyContent: 'center',
    minWidth: 112,
    paddingHorizontal: Spacing.four,
  },
  startText: {
    color: NavOssColors.paper,
    fontFamily: NavOssFonts.bold,
    fontSize: 17,
    letterSpacing: 0,
  },
  trafficStatus: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
  },
  useLocationButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 52,
    paddingHorizontal: Spacing.three,
  },
  useLocationText: {
    color: NavOssColors.paper,
    fontFamily: NavOssFonts.semibold,
    fontSize: 15,
    letterSpacing: 0,
  },
  vehicleButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  vehicleButtonSelected: {
    backgroundColor: NavOssColors.asphalt,
  },
  vehiclePicker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.one,
    padding: Spacing.one,
  },
});
