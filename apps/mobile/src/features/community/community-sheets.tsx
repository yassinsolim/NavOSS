import { useState } from 'react';
import { Alert, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type CommunityAvailability,
  reportSharingRowStatus,
  showReportsRowStatus,
  showTrafficRowStatus,
  trafficSharingRowStatus,
} from '@/features/community/community';
import { fullSheetHeight } from '@/features/map/overlay-layout';
import type { NativeTrafficSharingState } from '@/features/navigation/native-navigation';
import { createThemedStyles, radius, space, typography } from '@/theme';
import { Button } from '@/ui/button';
import { ListRow } from '@/ui/list-row';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';
import { SwitchRow } from '@/ui/switch-row';

function Point({ children, title }: { children: string; title: string }) {
  const styles = useStyles();
  return (
    <View style={styles.point}>
      <Text style={styles.pointTitle}>{title}</Text>
      <Text style={styles.pointBody}>{children}</Text>
    </View>
  );
}

/**
 * What sharing a road report means, asked before the first shared report. Declining keeps the
 * private-draft path exactly as it was.
 */
export function ShareReportsConsent({
  onAccept,
  onDecline,
  showTitle = true,
}: {
  onAccept: () => void;
  onDecline: () => void;
  /** Off where the surrounding sheet's own header already asks the question. */
  showTitle?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.consent}>
      {showTitle && (
        <Text accessibilityRole="header" style={styles.consentTitle}>
          Share road reports with other drivers?
        </Text>
      )}
      <Point title="What others see">
        The type of report on the map at an approximate location (about 50 m), roughly how long ago
        it was made, and how many drivers confirmed it. Never who made it.
      </Point>
      <Point title="What is sent">
        The report type, your location at that moment and your direction of travel, signed by this
        iPhone with Apple App Attest. No name, account, photo, destination or route.
      </Point>
      <Point title="Near home and trip ends">
        Close to your saved Home or Work, or your trip's start, destination or stops, NavOSS asks
        again before sharing.
      </Point>
      <Point title="Still there?">
        If you answer, your location is sent once, only to check you are within 1.5 km.
      </Point>
      <Point title="Turning it off">
        Reports expire after about two hours. Turn sharing off any time in Map appearance ›
        Community; reports then stay private on this iPhone.
      </Point>
      <View style={styles.actions}>
        <Button label="Share road reports" onPress={onAccept} size="driving" />
        <Button label="Keep reports private" onPress={onDecline} variant="secondary" />
      </View>
    </View>
  );
}

/**
 * "Share traffic speeds", explained in the words of the privacy policy (docs/privacy.md, Traffic
 * sharing). Opened from the Community settings before the switch can be turned on.
 */
export function TrafficSharingSheet({
  enabled,
  onClose,
  onSetEnabled,
  status,
  visible,
}: {
  enabled: boolean;
  onClose: () => void;
  onSetEnabled: (enabled: boolean) => void;
  status: { detail: string; enabled: boolean };
  visible: boolean;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  return (
    <ModalSheet
      accessibilityLabel="Share traffic speeds"
      // The explanation is longer than a phone screen: a full-height sheet that scrolls keeps
      // the header and its close button on screen.
      detents={[
        fullSheetHeight({ bottomInset: insets.bottom, topInset: insets.top, windowHeight }),
      ]}
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Close traffic sharing"
        eyebrow="Community traffic"
        onClose={onClose}
        title="Share traffic speeds"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.sheetContent, { paddingBottom: insets.bottom + space.lg }]}
      >
        <Point title="Off by default">
          Nothing is sent unless you turn this on. You can see traffic from other drivers without
          sharing your own.
        </Point>
        <Point title="What is sent">
          Only during turn-by-turn navigation, about once a minute: a short batch of the positions
          you drove, each with the seconds since the batch began, the time it began rounded down to
          the minute, and a short-lived upload credential. No account, name, destination, planned
          route or trip identifier.
        </Point>
        <Point title="What is left out">
          The first 400 m and the last 400 m of every trip, anything within 400 m of your
          destination or a stop, and the most recent 400 m, so a trip you end early never sends its
          final stretch. Nothing is sent while you browse, search, preview a route or drive without
          navigation.
        </Point>
        <Point title="What other drivers see">
          A road is coloured only after at least three installations have driven it recently, for at
          most 15 minutes, with its speed rounded to 5 km/h. Never a vehicle, a trip, a count of
          contributors or who contributed.
        </Point>
        <Point title="New on this iPhone">
          A newly registered iPhone starts sharing the day after it registers.
        </Point>
        <Point title="How to turn it off">
          Turn off Share traffic speeds in Map appearance › Community. Uploads stop immediately and
          anything not yet sent is discarded. Ending navigation does the same.
        </Point>
        <Text style={styles.footnote}>
          This is data minimisation with a threshold, not anonymity. The privacy policy lists what
          NavOSS cannot rule out.
        </Text>
        {status.enabled ? (
          <Button
            label={enabled ? 'Turn off traffic sharing' : 'Share traffic speeds'}
            onPress={() => {
              onSetEnabled(!enabled);
              onClose();
            }}
            size="driving"
            variant={enabled ? 'secondary' : 'primary'}
          />
        ) : (
          <Text accessibilityRole="text" style={styles.unavailable}>
            {status.detail}
          </Text>
        )}
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

export interface CommunitySettingsProps {
  availability: CommunityAvailability;
  hasIdentity: boolean;
  onResetIdentity: () => Promise<void>;
  onSetShareRoadReports: (enabled: boolean) => void;
  onSetShareTrafficSpeeds: (enabled: boolean) => void;
  onSetShowReports: (enabled: boolean) => void;
  onSetShowTraffic: (enabled: boolean) => void;
  sharesRoadReports: boolean;
  sharesTrafficSpeeds: boolean;
  showReports: boolean;
  showTraffic: boolean;
  trafficSharing: NativeTrafficSharingState | undefined;
}

/**
 * The Community section of Map appearance. Every row says what it does on this server today: a
 * switch the server cannot honour is shown off and disabled with "Not available yet".
 */
export function CommunitySettings({
  availability,
  hasIdentity,
  onResetIdentity,
  onSetShareRoadReports,
  onSetShareTrafficSpeeds,
  onSetShowReports,
  onSetShowTraffic,
  sharesRoadReports,
  sharesTrafficSpeeds,
  showReports,
  showTraffic,
  trafficSharing,
}: CommunitySettingsProps) {
  const styles = useStyles();
  const [consentVisible, setConsentVisible] = useState(false);
  const [trafficSheetVisible, setTrafficSheetVisible] = useState(false);
  const [resetting, setResetting] = useState(false);
  const reportSharing = reportSharingRowStatus(availability.reportSharing);
  const reports = showReportsRowStatus(availability.reports);
  const traffic = showTrafficRowStatus(availability.trafficFlow);
  const speeds = trafficSharingRowStatus(
    availability.trafficSharing,
    trafficSharing,
    sharesTrafficSpeeds,
  );
  const resetAvailable = hasIdentity && availability.reports === 'live';

  const confirmReset = () => {
    Alert.alert(
      'Reset community identity?',
      'NavOSS deletes this iPhone’s community identity with every report and answer it shared. Shared reports disappear for other drivers. The next time you share, a new identity is created that is not linked to this one.',
      [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: () => {
            setResetting(true);
            void onResetIdentity().finally(() => {
              setResetting(false);
            });
          },
          style: 'destructive',
          text: 'Reset identity',
        },
      ],
    );
  };

  return (
    <View style={styles.section}>
      <SectionTitle>Community</SectionTitle>
      <View style={styles.card}>
        <SwitchRow
          detail={reportSharing.detail}
          disabled={!reportSharing.enabled}
          label="Share road reports"
          onValueChange={(next) => {
            if (next) setConsentVisible(true);
            else {
              setConsentVisible(false);
              onSetShareRoadReports(false);
            }
          }}
          value={reportSharing.enabled && sharesRoadReports}
        />
        {consentVisible && reportSharing.enabled && !sharesRoadReports && (
          <ShareReportsConsent
            onAccept={() => {
              setConsentVisible(false);
              onSetShareRoadReports(true);
            }}
            onDecline={() => {
              setConsentVisible(false);
            }}
          />
        )}
        <SwitchRow
          detail={speeds.detail}
          disabled={!speeds.enabled}
          label="Share traffic speeds"
          onValueChange={(next) => {
            // Turning it on always goes through the explanation; turning it off never waits.
            if (next) setTrafficSheetVisible(true);
            else onSetShareTrafficSpeeds(false);
          }}
          value={speeds.enabled && sharesTrafficSpeeds}
        />
        <SwitchRow
          detail={reports.detail}
          disabled={!reports.enabled}
          label="Show reports on map"
          onValueChange={onSetShowReports}
          value={reports.enabled && showReports}
        />
        <SwitchRow
          detail={traffic.detail}
          disabled={!traffic.enabled}
          label="Show traffic"
          onValueChange={onSetShowTraffic}
          value={traffic.enabled && showTraffic}
        />
      </View>
      <View style={styles.linkCard}>
        <ListRow
          accessibilityLabel="How traffic sharing works"
          icon={{ android: 'info', ios: 'info.circle' }}
          onPress={() => {
            setTrafficSheetVisible(true);
          }}
          subtitle="What is sent, what is left out, how to turn it off"
          title="How traffic sharing works"
          trailing="chevron"
        />
      </View>
      <View style={styles.linkCard}>
        <ListRow
          accessibilityLabel="Reset community identity"
          icon={{ android: 'restart_alt', ios: 'arrow.counterclockwise' }}
          {...(resetAvailable && !resetting ? { onPress: confirmReset } : {})}
          subtitle={
            resetting
              ? 'Resetting…'
              : resetAvailable
                ? 'Deletes your shared reports and answers from NavOSS'
                : availability.reports === 'live'
                  ? 'This iPhone has not shared anything'
                  : 'Not available yet'
          }
          title="Reset community identity"
        />
      </View>
      {/* Nested: iOS presents it over this sheet instead of waiting for it to close. */}
      <TrafficSharingSheet
        enabled={sharesTrafficSpeeds}
        onClose={() => {
          setTrafficSheetVisible(false);
        }}
        onSetEnabled={onSetShareTrafficSpeeds}
        status={speeds}
        visible={trafficSheetVisible}
      />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    actions: { gap: space.sm, paddingTop: space.sm },
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      paddingHorizontal: space.lg,
    },
    consent: { gap: space.md, paddingBottom: space.lg, paddingTop: space.xs },
    consentTitle: { ...typography.title3, color: colors.text },
    footnote: { ...typography.footnote, color: colors.textSecondary },
    linkCard: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    point: { gap: 2 },
    pointBody: { ...typography.body, color: colors.textSecondary },
    pointTitle: { ...typography.bodyStrong, color: colors.text },
    section: { gap: space.sm },
    sheetContent: { gap: space.lg, paddingHorizontal: space.lg },
    unavailable: { ...typography.bodyStrong, color: colors.textSecondary, textAlign: 'center' },
  }),
);
