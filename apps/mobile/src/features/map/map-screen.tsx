import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  REPORT_AHEAD_HEIGHT,
  ReportAheadBanner,
  STILL_THERE_HEIGHT,
  StillTherePrompt,
} from '@/features/community/community-guidance';
import { AboutSheet } from '@/features/map/about-sheet';
import { AppTabBar } from '@/features/map/app-tab-bar';
import { CategoriesSheet } from '@/features/map/categories-sheet';
import { MapCanvas } from '@/features/map/components/map-canvas';
import { MapControls } from '@/features/map/components/map-controls';
import { MapLayers } from '@/features/map/components/map-layers';
import { MapNoticeToast } from '@/features/map/components/map-notice';
import { ContributeScreen } from '@/features/map/contribute-screen';
import { useMapController } from '@/features/map/controller/use-map-controller';
import { ExploreSheet } from '@/features/map/explore-sheet';
import { mapAttributionLabel, roadEventStatusLabel } from '@/features/map/map-features';
import { MapFeatureSheet } from '@/features/map/map-feature-sheet';
import {
  placePhoneUrl,
  placeReviewsUrl,
  placeWebsiteLabel,
  placeWebsiteUrl,
} from '@/features/map/map-place';
import { MapPreferencesSheet } from '@/features/map/map-preferences-sheet';
import { CAMERA_ALERT_HEIGHT, REROUTE_CARD_HEIGHT } from '@/features/map/overlay-layout';
import { PlaceSheet } from '@/features/map/place-sheet';
import { RoadReportSheet } from '@/features/map/road-report-sheet';
import { SavedPlacesScreen } from '@/features/map/saved-places-screen';
import { OfflineMapsSheet } from '@/features/offline/offline-maps-sheet';
import { mapProblemLabels } from '@/features/map/search-status';
import { CarPlayCompanionPanel, CarPlayIdlePanel } from '@/features/navigation/carplay-panels';
import {
  ArrivalSheet,
  DrivingStatus,
  LaneGuidanceStrip,
  ManeuverBanner,
  RerouteProposalCard,
  SafetyCameraAlertBanner,
  TripSheet,
} from '@/features/navigation/guidance';
import { GuidanceSettingsSheet } from '@/features/navigation/guidance-settings-sheet';
import { maneuverSignage } from '@/features/navigation/lane-guidance';
import { isCarPlayVisualHarness } from '@/features/navigation/native-navigation';
import { RoutePlanningSheet, RoutePreviewSheet } from '@/features/navigation/route-sheets';
import { RouteStopsEditor } from '@/features/navigation/route-stops-editor';
import { useRenderCounter } from '@/lib/render-counter';
import { createThemedStyles } from '@/theme';

const NO_SEARCH_RESULTS: readonly never[] = [];

/**
 * The app's one screen: a map with whichever sheet the current task needs on top of it. All
 * behaviour lives in `useMapController`; this component only decides what is on screen.
 *
 * Layering, back to front: map, floating controls, the active sheet, full-screen tabs and the
 * tab bar, banners that must stay above sheets (maneuver, camera alert, notices), then modal
 * sheets.
 */
export function MapScreen() {
  useRenderCounter('MapScreen');
  const styles = useStyles();
  const c = useMapController();
  const [creditsHeight, setCreditsHeight] = useState(0);
  const { metrics, route, guidance } = c;
  const routeState = route.state;
  const insets = { bottom: metrics.bottomInset, top: metrics.topInset };

  if (c.surface === 'guidance' && c.carPlayGuidance !== undefined) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <CarPlayCompanionPanel
          bottomInset={insets.bottom}
          destinationName={c.carPlayGuidance.destination.name}
          durationSeconds={c.carPlayGuidance.remainingDurationSeconds}
          maneuvers={c.carPlayGuidance.maneuvers}
          onAction={c.onEndNavigation}
          phase="navigating"
          remainingDistanceMeters={c.carPlayGuidance.remainingDistanceMeters}
          safeAreaTop={insets.top}
        />
      </View>
    );
  }

  if (c.surface === 'arrival' && routeState.type === 'arrived') {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <CarPlayCompanionPanel
          bottomInset={insets.bottom}
          destinationName={routeState.destination.name}
          onAction={c.onFinishArrival}
          phase="arrived"
          safeAreaTop={insets.top}
        />
      </View>
    );
  }

  if (c.surface === 'carplay-idle') {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <CarPlayIdlePanel
          bottomInset={insets.bottom}
          onEnd={c.onEndNavigation}
          safeAreaTop={insets.top}
        />
      </View>
    );
  }

  if (isCarPlayVisualHarness()) return null;

  const exploring = c.activeTab === 'explore';
  const navigating = routeState.type === 'navigating';
  const routeIsIdle = routeState.type === 'idle';
  const mapChromeVisible = exploring || !c.appShellVisible;
  const { overlays, mapPreferences, selectedResult } = c;
  const safetyCameraCount = mapPreferences.showSafetyCameras ? overlays.safetyCameras.length : 0;
  const roadEventCount = mapPreferences.showRoadEvents ? overlays.roadEvents.length : 0;
  const communityReportCount = c.community.reports.length;
  const mapSummary = `Map with ${countLabel(safetyCameraCount, 'official safety camera symbol')}, ${countLabel(roadEventCount, 'road event')} and ${countLabel(communityReportCount, 'driver report')}`;
  const selectedPlacePhoneUrl = placePhoneUrl(selectedResult?.details?.phone);
  const selectedPlaceWebsiteUrl = placeWebsiteUrl(selectedResult?.details?.website);
  const guidanceReady =
    routeState.type === 'navigating' &&
    guidance.step !== undefined &&
    guidance.remainingRoute !== undefined &&
    guidance.remainingStep !== undefined;
  const cameraAlertHeight = navigating && c.cameraAlert !== undefined ? CAMERA_ALERT_HEIGHT : 0;
  const rerouteCardHeight = guidance.rerouteProposal === undefined ? 0 : REROUTE_CARD_HEIGHT;
  const reportAheadHeight =
    navigating && c.community.reportAhead !== undefined ? REPORT_AHEAD_HEIGHT : 0;
  const stillThereHeight =
    navigating && c.community.stillThere !== undefined ? STILL_THERE_HEIGHT : 0;
  const guidanceStackTop =
    insets.top + guidance.bannerHeight + 8 + cameraAlertHeight + rerouteCardHeight;

  return (
    <View style={styles.container}>
      <StatusBar style={navigating || (exploring && c.darkMap) ? 'light' : 'auto'} />
      <MapCanvas
        accessibilityLabel={mapSummary}
        cameraRef={c.cameraRef}
        hidden={!exploring}
        idleCenter={c.camera.idleCenter}
        idleShouldFollow={c.camera.idleShouldFollow}
        isNavigating={navigating}
        isNavigationFollowing={c.camera.isNavigationFollowing}
        mapRef={c.mapRef}
        mapStyle={c.mapStyle}
        metrics={metrics}
        navigationBearing={c.camera.navigationBearing}
        navigationView={mapPreferences.navigationView}
        onCameraChange={c.camera.onChange}
        onLoadError={c.onMapError}
        onLongPress={c.onMapLongPress}
        onPress={c.onMapPress}
        onRegionDidChange={c.onRegionDidChange}
        vehicleCoordinate={c.camera.followCenter}
      >
        <MapLayers
          alternateRoutes={route.alternateRoutes}
          basemapLabelLayerId={c.basemapLabelLayerId}
          communityReports={c.community.reports}
          darkMap={c.darkMap}
          deviceHeadingStore={c.location.deviceHeadingStore}
          displayedSelectedRoute={route.displayedSelectedRoute}
          isNavigating={navigating}
          roadEvents={overlays.roadEvents}
          routeColor={mapPreferences.routeColor}
          safetyCameras={c.visibleSafetyCameras}
          safetyFacilities={overlays.kelownaSafetyFacilities}
          searchResults={routeIsIdle ? c.search.results : NO_SEARCH_RESULTS}
          selectedResult={selectedResult}
          selectedRouteCongestion={route.selectedRouteCongestion}
          showRoadEvents={mapPreferences.showRoadEvents && overlays.roadEventSnapshot !== undefined}
          showSafetyCameras={mapPreferences.showSafetyCameras}
          showSafetyFacilities={mapPreferences.showPlaces}
          showUserLocation={
            c.location.locationState === 'visible' && !navigating && c.phoneMapVisible
          }
          torontoSafetyCameras={overlays.torontoSafetyCameras}
          trafficCameras={overlays.kelownaTrafficCameras}
          trafficFlow={c.community.trafficFlow}
          userCoordinate={c.location.userCoordinate}
          userHeading={c.location.userHeading}
          vehicleCoordinate={c.camera.vehicleCoordinate}
          vehicleStyle={route.vehicleStyle}
          zoomStepStore={c.zoomStepStore}
        />
      </MapCanvas>

      {mapChromeVisible && (
        <MapControls
          attribution={
            (c.mapStyleOffline ? 'Offline map · ' : '') +
            mapAttributionLabel({
              hasTorontoCameras: overlays.torontoSafetyCameras.length > 0,
              mapRegion: c.location.mapRegion,
              roadEventRegion: overlays.roadEventRegion,
            })
          }
          bannerStackHeight={
            guidance.bannerHeight +
            cameraAlertHeight +
            rerouteCardHeight +
            reportAheadHeight +
            stillThereHeight
          }
          locating={c.location.locationState === 'locating'}
          mapBearing={c.mapBearing}
          metrics={metrics}
          mode={
            navigating
              ? 'guidance'
              : routeState.type === 'arrived'
                ? 'arrived'
                : c.appShellVisible
                  ? 'explore'
                  : 'planning'
          }
          onLocate={c.location.locate}
          onOpenAbout={c.about.open}
          onOpenMapPreferences={c.mapPreferencesSheet.open}
          onOpenReport={c.roadReport.open}
          onRecenter={c.camera.recenter}
          onShowAttribution={c.onShowAttribution}
          onToggleOrientation={c.onToggleOrientation}
          orientation={mapPreferences.navigationOrientation}
          problems={mapProblemLabels({
            apiConnection: c.apiConnection,
            locationState: c.location.locationState,
            mapError: c.mapError,
            routeIsIdle,
          }).join(' · ')}
          roadEventStatus={
            mapPreferences.showRoadEvents
              ? roadEventStatusLabel({
                  hasSnapshot: overlays.roadEventSnapshot !== undefined,
                  refreshDelayed: overlays.roadEventRefreshDelayed,
                  region: overlays.roadEventRegion,
                  stale: overlays.roadEventSnapshot?.stale === true,
                })
              : undefined
          }
          sheetPosition={c.sheetPosition}
          showRecenter={!c.camera.isNavigationFollowing}
          onCreditsHeightChange={setCreditsHeight}
          trafficStatus={c.community.trafficStatus}
        />
      )}

      {navigating && (
        <DrivingStatus
          creditsHeight={creditsHeight}
          roadName={guidance.currentRoadName}
          sheetPosition={c.sheetPosition}
          speed={guidance.speed}
        />
      )}

      {c.appShellVisible && exploring && (
        <ExploreSheet
          apiConnection={c.apiConnection}
          catalog={c.destinationCatalog}
          coverageName={c.coverageName}
          locationState={c.location.locationState}
          metrics={metrics}
          nearbySearchEnabled={c.location.nearbySearchEnabled}
          onCategoryPress={c.categories.onPress}
          onChangeQuery={c.onChangeQuery}
          onChooseSavedPlace={c.onChooseSavedPlace}
          onClear={c.onClearSearch}
          onOpenMoreCategories={c.categories.open}
          onSelectResult={c.onSelectResult}
          onShortcutPress={c.onShortcutPress}
          onSubmit={c.onSubmitSearch}
          position={c.sheetPosition}
          query={c.search.query}
          results={c.search.results}
          resultsDegraded={c.search.resultsDegraded}
          searchSource={c.search.searchSource}
          searchState={c.search.searchState}
          selectedCategoryId={c.search.selectedCategoryId}
          sheetRef={c.exploreSheetRef}
          shortcutBeingSet={c.shortcutBeingSet}
        />
      )}

      {c.placeSheetVisible && selectedResult !== undefined && (
        <PlaceSheet
          loading={c.placeDetailsLoading}
          metrics={metrics}
          onClose={c.onClosePlace}
          onDirections={c.onPlaceDirections}
          onFindParking={c.onFindParking}
          onReadReviews={() => {
            c.onOpenExternalUrl(placeReviewsUrl(selectedResult));
          }}
          onSave={c.onToggleSaved}
          onShare={c.onSharePlace}
          {...(selectedPlacePhoneUrl === undefined
            ? {}
            : {
                onCall: () => {
                  c.onOpenExternalUrl(selectedPlacePhoneUrl);
                },
              })}
          {...(selectedPlaceWebsiteUrl === undefined
            ? {}
            : {
                onWebsite: () => {
                  c.onOpenExternalUrl(selectedPlaceWebsiteUrl);
                },
              })}
          place={selectedResult}
          position={c.sheetPosition}
          ratingAvailable={c.googlePlaceRatingAvailable}
          saved={c.selectedPlaceSaved}
          websiteLabel={placeWebsiteLabel(selectedResult.details?.website)}
        />
      )}

      {(routeState.type === 'loading' || routeState.type === 'error') && (
        <RoutePlanningSheet
          bottomInset={insets.bottom}
          destination={routeState.destination}
          errorMessage={routeState.type === 'error' ? routeState.message : undefined}
          onCancel={c.onCancelRoute}
          onPreviewSupportedRoute={c.onPreviewSupportedRoute}
          onRetry={c.onRetryRoute}
          position={c.sheetPosition}
        />
      )}

      {routeState.type === 'preview' && route.selectedRoute !== undefined && (
        <RoutePreviewSheet
          destination={routeState.destination}
          initialDetent={route.previewDetent}
          metrics={metrics}
          onCancel={c.onCancelRoute}
          onDetentChange={route.onPreviewDetentChange}
          onEditStops={c.routeStops.open}
          onSelectRoute={c.onSelectRoute}
          onStart={c.onStartNavigation}
          onToggleRoutePreference={c.onToggleRoutePreference}
          onUseCurrentLocation={c.onUseCurrentLocation}
          onVehicleStyleChange={route.setVehicleStyle}
          position={c.sheetPosition}
          previewOriginLabel={
            routeState.previewOrigin === undefined ? undefined : 'Supported route demo'
          }
          routePreferences={route.preferences}
          routeSource={route.source}
          routes={routeState.routes}
          selectedRoute={route.selectedRoute}
          vehicleStyle={route.vehicleStyle}
          waypoints={routeState.waypoints}
        />
      )}

      {guidanceReady && guidance.remainingRoute !== undefined && (
        <TripSheet
          audioMode={c.guidanceSettings.settings.audioMode}
          cameraAnnouncementCount={c.cameraAnnouncementCount}
          destinationName={routeState.destination.name}
          distanceMeters={guidance.remainingRoute.distanceMeters}
          durationSeconds={guidance.remainingRoute.durationSeconds}
          matchStatus={guidance.vehicleMatchStatus}
          metrics={metrics}
          onEnd={c.onEndNavigation}
          onReport={c.roadReport.open}
          onShare={c.onShareEta}
          onSound={c.guidanceSettings.open}
          position={c.sheetPosition}
          positionEstimated={guidance.positionEstimated}
          rerouteCount={guidance.rerouteCount}
          route={route.selectedRoute}
          routeSource={route.source}
          upcomingManeuvers={guidance.upcomingManeuvers ?? []}
        />
      )}

      {routeState.type === 'arrived' && (
        <ArrivalSheet
          bottomInset={insets.bottom}
          destination={routeState.destination}
          onDone={c.onFinishArrival}
          position={c.sheetPosition}
        />
      )}

      {c.appShellVisible && c.activeTab === 'saved' && (
        <SavedPlacesScreen
          bottomInset={insets.bottom}
          catalog={c.destinationCatalog}
          onChoose={c.onChooseSavedPlace}
          onClearHistory={c.onClearRecents}
          onRemoveShortcut={c.onRemoveShortcut}
          onSetShortcut={c.onBeginShortcutSetup}
          safeAreaTop={insets.top}
        />
      )}
      {c.appShellVisible && c.activeTab === 'contribute' && (
        <ContributeScreen bottomInset={insets.bottom} safeAreaTop={insets.top} />
      )}
      {c.appShellVisible && (
        <AppTabBar activeTab={c.activeTab} bottomInset={insets.bottom} onSelect={c.onSelectTab} />
      )}

      {guidanceReady && guidance.step !== undefined && guidance.remainingStep !== undefined && (
        <ManeuverBanner
          distanceMeters={guidance.remainingStep.distanceMeters}
          instruction={guidance.step.instruction}
          maneuverModifier={guidance.step.maneuverModifier}
          maneuverType={guidance.step.maneuverType}
          onHeightChange={guidance.onBannerHeightChange}
          roadName={guidance.step.roadName}
          safeAreaTop={insets.top}
          signage={maneuverSignage(guidance.step)}
          status={guidance.routeStatus}
        >
          {guidance.laneStrip !== undefined && <LaneGuidanceStrip strip={guidance.laneStrip} />}
        </ManeuverBanner>
      )}
      {navigating && c.cameraAlert !== undefined && (
        <SafetyCameraAlertBanner
          camera={c.cameraAlert.camera}
          distanceAheadMeters={c.cameraAlert.distanceAheadMeters}
          top={insets.top + guidance.bannerHeight + 8}
        />
      )}
      {guidance.rerouteProposal !== undefined && (
        <RerouteProposalCard
          distanceDeltaMeters={guidance.rerouteProposal.distanceDeltaMeters}
          distanceMeters={guidance.rerouteProposal.distanceMeters}
          durationDeltaSeconds={guidance.rerouteProposal.durationDeltaSeconds}
          durationSeconds={guidance.rerouteProposal.durationSeconds}
          onAccept={guidance.onAcceptReroute}
          onKeep={guidance.onKeepRoute}
          top={insets.top + guidance.bannerHeight + 8 + cameraAlertHeight}
        />
      )}
      {navigating && c.community.reportAhead !== undefined && (
        <ReportAheadBanner report={c.community.reportAhead} top={guidanceStackTop} />
      )}
      {navigating && c.community.stillThere !== undefined && (
        <StillTherePrompt
          busy={c.community.stillThereBusy}
          onAnswer={c.community.onAnswerStillThere}
          onDismiss={c.community.onDismissStillThere}
          prompt={c.community.stillThere}
          top={guidanceStackTop + reportAheadHeight}
        />
      )}
      <MapNoticeToast
        notice={c.notice}
        onDismiss={c.onDismissNotice}
        top={
          insets.top +
          8 +
          (navigating
            ? guidance.bannerHeight +
              cameraAlertHeight +
              rerouteCardHeight +
              reportAheadHeight +
              stillThereHeight
            : 0)
        }
      />

      <MapPreferencesSheet
        community={c.community.settings}
        metrics={metrics}
        onChange={c.onUpdateMapPreferences}
        onClose={c.mapPreferencesSheet.close}
        onClosed={c.mapPreferencesSheet.onClosed}
        onOpenGuidanceSettings={c.guidanceSettings.open}
        onOpenOfflineMaps={c.offlineMaps.open}
        preferences={mapPreferences}
        visible={c.mapPreferencesSheet.visible}
      />
      <OfflineMapsSheet
        metrics={metrics}
        onClose={c.offlineMaps.close}
        visible={c.offlineMaps.visible}
      />
      <AboutSheet
        coverageName={c.coverageName}
        metrics={metrics}
        onClearDestinationHistory={c.onClearDestinationHistory}
        onClose={c.about.close}
        visible={c.about.visible}
      />
      <CategoriesSheet
        metrics={metrics}
        onCategoryPress={c.categories.onPress}
        onClose={c.categories.close}
        visible={c.categories.visible}
      />
      <RoadReportSheet
        isSaving={c.roadReport.saving}
        nearPrivatePlace={c.roadReport.nearPrivatePlace}
        onCancel={c.roadReport.close}
        onKeepPrivate={c.roadReport.keepPrivate}
        onSelect={c.roadReport.save}
        onSetShareRoadReports={c.roadReport.setShareRoadReports}
        onShareAnyway={c.roadReport.shareAnyway}
        sharing={c.roadReport.sharing}
        visible={c.roadReport.visible}
      />
      <GuidanceSettingsSheet
        metrics={metrics}
        onChange={c.guidanceSettings.change}
        onClose={c.guidanceSettings.close}
        settings={c.guidanceSettings.settings}
        visible={c.guidanceSettings.visible}
      />
      <MapFeatureSheet
        busyAction={c.communityActionBusy}
        detail={c.featureDetail}
        onAction={c.onCommunityReportAction}
        onClose={c.onCloseFeatureDetail}
        onOpenLink={c.onOpenExternalUrl}
      />
      {routeState.type === 'preview' && (
        <RouteStopsEditor
          destinations={[...routeState.waypoints, routeState.destination]}
          metrics={metrics}
          onApply={c.onApplyRouteStops}
          onClose={c.routeStops.close}
          origin={c.location.userCoordinate}
          visible={c.routeStops.visible}
        />
      )}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    container: { backgroundColor: colors.background, flex: 1 },
  }),
);

/** "1 road event", "2 road events": the map's VoiceOver summary reads naturally. */
function countLabel(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
