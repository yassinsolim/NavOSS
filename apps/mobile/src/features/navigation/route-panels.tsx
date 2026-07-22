import type {
  RouteAlternative,
  RouteResponse,
  SafetyCamera,
  SearchResult,
} from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import {
  formatArrivalTime,
  formatDistance,
  formatDuration,
  routeViaLabel,
} from '@/features/navigation/route-progress';
import {
  maneuverDirection,
  type ManeuverDirection,
} from '@/features/navigation/maneuver-direction';
import type { VehicleMatchStatus, VehicleStyle } from '@/features/navigation/vehicle-puck';

interface RoutePlanningPanelProps {
  bottomInset: number;
  destination: SearchResult;
  errorMessage?: string;
  onCancel: () => void;
  onRetry: () => void;
}

export function RoutePlanningPanel({
  bottomInset,
  destination,
  errorMessage,
  onCancel,
  onRetry,
}: RoutePlanningPanelProps) {
  return (
    <View style={[styles.bottomPanel, { paddingBottom: Math.max(bottomInset, 14) }]}>
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleCopy}>
          <Text numberOfLines={1} style={styles.eyebrow}>
            {errorMessage === undefined ? 'Finding the best route' : 'Route unavailable'}
          </Text>
          <Text numberOfLines={1} style={styles.destinationName}>
            {destination.name}
          </Text>
        </View>
        <Pressable accessibilityLabel="Cancel route" onPress={onCancel} style={styles.iconButton}>
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={19}
            tintColor={NavOssColors.muted}
          />
        </Pressable>
      </View>

      {errorMessage === undefined ? (
        <View style={styles.planningRow}>
          <ActivityIndicator color={NavOssColors.green} size="small" />
          <Text style={styles.planningText}>Using your current location</Text>
        </View>
      ) : (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <Pressable accessibilityLabel="Retry route" onPress={onRetry} style={styles.retryButton}>
            <SymbolView
              name={{ android: 'refresh', ios: 'arrow.clockwise' }}
              size={18}
              tintColor={NavOssColors.white}
            />
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

interface RoutePreviewPanelProps {
  avoidHighways: boolean;
  bottomInset: number;
  destination: SearchResult;
  onCancel: () => void;
  onSelectRoute: (route: RouteAlternative) => void;
  onStart: () => void;
  onToggleAvoidHighways: () => void;
  onVehicleStyleChange: (vehicleStyle: VehicleStyle) => void;
  routes: RouteAlternative[];
  selectedRoute: RouteAlternative;
  trafficStatus: RouteResponse['source']['traffic'];
  vehicleStyle: VehicleStyle;
}

export function RoutePreviewPanel({
  avoidHighways,
  bottomInset,
  destination,
  onCancel,
  onSelectRoute,
  onStart,
  onToggleAvoidHighways,
  onVehicleStyleChange,
  routes,
  selectedRoute,
  trafficStatus,
  vehicleStyle,
}: RoutePreviewPanelProps) {
  return (
    <View
      style={[
        styles.bottomPanel,
        styles.previewPanel,
        { paddingBottom: Math.max(bottomInset, 12) },
      ]}
    >
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleCopy}>
          <Text style={styles.eyebrow}>Route preview</Text>
          <Text numberOfLines={1} style={styles.destinationName}>
            {destination.name}
          </Text>
        </View>
        <Pressable accessibilityLabel="Cancel route" onPress={onCancel} style={styles.iconButton}>
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
        {routes.map((route, index) => {
          const selected = route.id === selectedRoute.id;
          const viaLabel = routeViaLabel(route);
          return (
            <Pressable
              accessibilityLabel={`Select ${route.label} ${formatDuration(route.durationSeconds)} route, ${formatDistance(route.distanceMeters)}, ${viaLabel}`}
              key={route.id}
              onPress={() => {
                onSelectRoute(route);
              }}
              style={[styles.routeChoice, selected && styles.routeChoiceSelected]}
            >
              <Text style={[styles.routeChoiceEta, selected && styles.routeChoiceEtaSelected]}>
                {formatDuration(route.durationSeconds)}
              </Text>
              <Text style={[styles.routeChoiceMeta, selected && styles.routeChoiceMetaSelected]}>
                {index === 0
                  ? `Fastest · ${formatDistance(route.distanceMeters)}`
                  : formatDistance(route.distanceMeters)}
              </Text>
              <Text
                numberOfLines={2}
                style={[styles.routeVia, selected && styles.routeChoiceMetaSelected]}
              >
                {viaLabel}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.routeOptions}>
        <Pressable
          accessibilityLabel="Avoid highways"
          accessibilityRole="switch"
          accessibilityState={{ checked: avoidHighways }}
          onPress={onToggleAvoidHighways}
          style={[styles.optionButton, avoidHighways && styles.optionButtonSelected]}
        >
          <SymbolView
            name={{ android: 'alt_route', ios: 'arrow.triangle.branch' }}
            size={17}
            tintColor={avoidHighways ? NavOssColors.white : NavOssColors.asphalt}
          />
          <Text style={[styles.optionText, avoidHighways && styles.optionTextSelected]}>
            Avoid highways
          </Text>
        </Pressable>

        <View accessibilityLabel="Navigation marker" style={styles.vehiclePicker}>
          {(['arrow', 'car'] as const).map((style) => {
            const selected = style === vehicleStyle;
            return (
              <Pressable
                accessibilityLabel={`Use ${style} navigation marker`}
                key={style}
                onPress={() => {
                  onVehicleStyleChange(style);
                }}
                style={[styles.vehicleButton, selected && styles.vehicleButtonSelected]}
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
        </View>
        <Pressable
          accessibilityLabel="Start navigation"
          onPress={onStart}
          style={styles.startButton}
        >
          <SymbolView
            name={{ android: 'navigation', ios: 'location.north.fill' }}
            size={21}
            tintColor={NavOssColors.white}
          />
          <Text style={styles.startText}>Start</Text>
        </Pressable>
      </View>

      <View style={styles.sourceRow}>
        <Text style={styles.developmentSource}>Valhalla + OpenStreetMap · Development</Text>
        <Text style={styles.trafficStatus}>
          {trafficStatus === 'unavailable' ? 'No live traffic' : trafficStatus}
        </Text>
      </View>
    </View>
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
    <View
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
    </View>
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
    <View
      accessibilityLabel={`Red light and speed camera ahead, ${distance}, ${camera.location}`}
      accessibilityLiveRegion="polite"
      accessible
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
    </View>
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
    <View style={[styles.bottomPanel, { paddingBottom: Math.max(bottomInset, 14) }]}>
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
          <Text numberOfLines={1} style={styles.destinationName}>
            {destination.name}
          </Text>
        </View>
      </View>
      <Pressable accessibilityLabel="Finish navigation" onPress={onDone} style={styles.doneButton}>
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </View>
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
    <View
      accessibilityLabel={`${displayedDistance}, ${displayedInstruction}${displayedRoadName.length === 0 ? '' : `, ${displayedRoadName}`}`}
      accessibilityLiveRegion="polite"
      accessible
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
    </View>
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
  bottomInset: number;
  cameraAnnouncementCount: number;
  distanceMeters: number;
  durationSeconds: number;
  matchStatus: VehicleMatchStatus;
  onEnd: () => void;
  onShare: () => void;
  rerouteCount: number;
}

export function NavigationStatusBar({
  bottomInset,
  cameraAnnouncementCount,
  distanceMeters,
  durationSeconds,
  matchStatus,
  onEnd,
  onShare,
  rerouteCount,
}: NavigationStatusBarProps) {
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
    <View style={[styles.navigationStatus, { paddingBottom: Math.max(bottomInset, 10) }]}>
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
      <View style={styles.navigationActions}>
        <Pressable
          accessibilityHint="Opens the system share sheet without reading your contacts"
          accessibilityLabel="Share ETA"
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
    </View>
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
    backgroundColor: NavOssColors.white,
    borderTopColor: NavOssColors.border,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    minHeight: 156,
    paddingHorizontal: 16,
    paddingTop: 14,
    position: 'absolute',
    right: 0,
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
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
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
    color: NavOssColors.coral,
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
    fontFamily: NavOssFonts.semibold,
    fontSize: 20,
    letterSpacing: 0,
  },
  developmentSource: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 11,
    letterSpacing: 0,
    flex: 1,
  },
  doneButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 7,
    height: 48,
    justifyContent: 'center',
    marginTop: 14,
  },
  doneText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.semibold,
    fontSize: 17,
    letterSpacing: 0,
  },
  endButton: {
    alignItems: 'center',
    backgroundColor: '#FCE9E5',
    justifyContent: 'center',
  },
  errorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    marginTop: 14,
  },
  errorText: {
    color: NavOssColors.muted,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
    lineHeight: 19,
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
    height: 42,
    justifyContent: 'center',
    width: 42,
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
    shadowColor: '#000000',
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
    opacity: 0.68,
    transform: [{ scale: 0.96 }],
  },
  navigationActions: {
    flexDirection: 'row',
    gap: 7,
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
    fontSize: 11,
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
    backgroundColor: NavOssColors.white,
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
    gap: 6,
    height: 36,
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
    color: NavOssColors.white,
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
    gap: 10,
    marginTop: 18,
  },
  planningText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
  },
  previewPanel: {
    minHeight: 314,
  },
  previewSummary: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    marginTop: 12,
  },
  retryButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 6,
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  retryText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.semibold,
    fontSize: 15,
    letterSpacing: 0,
  },
  routeChoice: {
    borderColor: NavOssColors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 2,
    minWidth: 142,
    minHeight: 88,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  routeChoiceEta: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  routeChoiceEtaSelected: {
    color: NavOssColors.white,
  },
  routeChoiceMeta: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 12,
    letterSpacing: 0,
  },
  routeChoiceMetaSelected: {
    color: '#D7E8E5',
  },
  routeChoiceSelected: {
    backgroundColor: NavOssColors.green,
    borderColor: NavOssColors.green,
  },
  routeChoices: {
    gap: 8,
    paddingVertical: 11,
  },
  routeOptions: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  routeVia: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 11,
    letterSpacing: 0,
    marginTop: 2,
    maxWidth: 170,
    minHeight: 28,
  },
  shareEtaButton: {
    backgroundColor: NavOssColors.sky,
  },
  sourceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  startButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 7,
    height: 50,
    justifyContent: 'center',
    minWidth: 112,
    paddingHorizontal: 18,
  },
  startText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 17,
    letterSpacing: 0,
  },
  trafficStatus: {
    color: NavOssColors.coral,
    fontFamily: NavOssFonts.medium,
    fontSize: 11,
    letterSpacing: 0,
  },
  vehicleButton: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 34,
  },
  vehicleButtonSelected: {
    backgroundColor: NavOssColors.asphalt,
  },
  vehiclePicker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: 17,
    flexDirection: 'row',
    gap: 2,
    height: 34,
    paddingHorizontal: 2,
  },
});
