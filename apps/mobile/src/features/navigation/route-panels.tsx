import type { RouteAlternative, RouteResponse, SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import {
  formatArrivalTime,
  formatDistance,
  formatDuration,
  routeViaLabel,
} from '@/features/navigation/route-progress';
import type { VehicleStyle } from '@/features/navigation/vehicle-puck';

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
              accessibilityLabel={`Select ${formatDuration(route.durationSeconds)} route, ${formatDistance(route.distanceMeters)}, ${viaLabel}`}
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
                {index === 0 ? 'Fastest' : formatDistance(route.distanceMeters)}
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

interface NavigationBannerProps {
  instruction: string;
  roadName: string;
  safeAreaTop: number;
}

export function NavigationBanner({ instruction, roadName, safeAreaTop }: NavigationBannerProps) {
  return (
    <View style={[styles.navigationBanner, { top: safeAreaTop + 8 }]}>
      <View style={styles.maneuverIcon}>
        <SymbolView
          name={{ android: 'near_me', ios: 'arrow.up.right' }}
          size={29}
          tintColor={NavOssColors.asphalt}
        />
      </View>
      <View style={styles.guidanceCopy}>
        <Text numberOfLines={2} style={styles.guidanceInstruction}>
          {instruction}
        </Text>
        {roadName.length > 0 && (
          <Text numberOfLines={1} style={styles.guidanceRoad}>
            {roadName}
          </Text>
        )}
      </View>
    </View>
  );
}

interface NavigationStatusBarProps {
  bottomInset: number;
  distanceMeters: number;
  durationSeconds: number;
  onEnd: () => void;
}

export function NavigationStatusBar({
  bottomInset,
  distanceMeters,
  durationSeconds,
  onEnd,
}: NavigationStatusBarProps) {
  return (
    <View style={[styles.navigationStatus, { paddingBottom: Math.max(bottomInset, 10) }]}>
      <View style={styles.navigationMetric}>
        <Text style={styles.navigationEta}>{formatDuration(durationSeconds)}</Text>
        <Text style={styles.navigationMeta}>
          {formatDistance(distanceMeters)} · {formatArrivalTime(durationSeconds)}
        </Text>
      </View>
      <Pressable accessibilityLabel="End navigation" onPress={onEnd} style={styles.endButton}>
        <SymbolView
          name={{ android: 'stop_circle', ios: 'xmark.circle.fill' }}
          size={22}
          tintColor={NavOssColors.coral}
        />
        <Text style={styles.endText}>End</Text>
      </Pressable>
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
  endButton: {
    alignItems: 'center',
    backgroundColor: '#FCE9E5',
    borderRadius: 7,
    flexDirection: 'row',
    gap: 6,
    height: 46,
    justifyContent: 'center',
    paddingHorizontal: 15,
  },
  endText: {
    color: NavOssColors.coral,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
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
    gap: 3,
    minWidth: 0,
  },
  guidanceInstruction: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.semibold,
    fontSize: 20,
    letterSpacing: 0,
    lineHeight: 24,
  },
  guidanceRoad: {
    color: '#C8D4D1',
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
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
    backgroundColor: NavOssColors.sun,
    borderRadius: 7,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  navigationBanner: {
    alignItems: 'center',
    backgroundColor: NavOssColors.asphalt,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 13,
    left: 12,
    minHeight: 82,
    padding: 12,
    position: 'absolute',
    right: 12,
    shadowColor: '#000000',
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    zIndex: 30,
  },
  navigationEta: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 24,
    letterSpacing: 0,
  },
  navigationMeta: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
  },
  navigationMetric: {
    flex: 1,
    gap: 1,
  },
  navigationStatus: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    flexDirection: 'row',
    gap: 12,
    left: 0,
    minHeight: 86,
    paddingHorizontal: 16,
    paddingTop: 10,
    position: 'absolute',
    right: 0,
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
