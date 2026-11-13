import { type ReactNode, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import { getGooglePlacesOpenSourceLicenseInfo } from '@/features/navigation/native-navigation';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { ListRow } from '@/ui/list-row';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';

const PRIVACY_POLICY_URL = 'https://navoss.yassin.app/privacy';
const SUPPORT_URL = 'https://navoss.yassin.app/support';

function Section({ children, title }: { children: ReactNode; title: string }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * About, privacy and data sources. The copy states only what this build does; it is the app's
 * in-product privacy disclosure and must change in the same commit as the behaviour it describes.
 */
export function AboutSheet({
  coverageName,
  metrics,
  onClearDestinationHistory,
  onClose,
  visible,
}: {
  coverageName: string;
  metrics: ScreenMetrics;
  onClearDestinationHistory: () => void;
  onClose: () => void;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [isGoogleLicensesVisible, setIsGoogleLicensesVisible] = useState(false);
  const [googlePlacesLicenseInfo] = useState(() => getGooglePlacesOpenSourceLicenseInfo());
  const detents = [fullSheetHeight(metrics)];

  return (
    <ModalSheet
      accessibilityLabel="About and privacy"
      detents={detents}
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Close about and privacy"
        eyebrow="About NavOSS"
        onClose={onClose}
        title="Navigation without an account"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        <Text style={styles.lead}>
          NavOSS is account-free, privacy-first navigation with regional official road context.
        </Text>

        <Section title="Search and routing">
          <Text style={styles.body}>
            Current place search and driving-route coverage: {coverageName}. Regional road events,
            traffic cameras, and public safety facilities may be available elsewhere without
            implying route coverage.
          </Text>
        </Section>

        <Section title="Privacy">
          <Text style={styles.body}>
            Precise location is used to show your position, match you to an active route, detect
            reroutes and arrival, and warn about safety cameras. During active navigation, location
            continues while your phone is locked or connected to CarPlay and iOS shows its
            background location indicator. Search text and route endpoints are sent to the NavOSS
            API and its configured search and routing provider. Current production uses self-hosted
            OpenStreetMap services; a licensed live-traffic deployment may send route endpoints to
            Mapbox. Rerouting sends your latest route origin.
          </Text>
          <Text style={styles.body}>
            NavOSS does not require an account, show ads, request Always location access, or send
            destination history to its servers. Up to 12 recent destinations and 20 places you save
            are stored only on this device for phone and CarPlay shortcuts. Ending navigation stops
            background location and erases the transient active route.
          </Text>
          {googlePlacesLicenseInfo !== undefined && (
            <Text style={styles.body}>
              When a point-of-interest sheet opens, its coordinate is sent directly to Google Places
              so Google's own component can render available photos, rating and rating count,
              reviews, and attribution. NavOSS does not retain that Google content.
              GooglePlacesSwift 10.15.0's embedded privacy manifest also declares Google collection
              of precise and coarse location, device ID, other data, performance data, product
              interaction, and search history for analytics and/or app functionality, but not
              tracking. More reviews open in Google Maps only after you choose the external link.
            </Text>
          )}
          <View style={styles.links}>
            <ListRow
              accessibilityLabel="Open NavOSS privacy policy"
              accessibilityRole="link"
              icon={{ android: 'policy', ios: 'hand.raised.fill' }}
              onPress={() => {
                void Linking.openURL(PRIVACY_POLICY_URL);
              }}
              title="Privacy policy"
              trailing="external"
            />
            <ListRow
              accessibilityLabel="Clear saved and recent destinations"
              icon={{ android: 'delete', ios: 'trash' }}
              iconTint={colors.dangerText}
              onPress={onClearDestinationHistory}
              title="Clear saved and recent destinations"
              titleLines={2}
            />
          </View>
        </Section>

        <Section title="Support and feedback">
          <Text style={styles.body}>
            Route reports are most useful when they include the start area, destination, time, and
            unexpected road or maneuver. Avoid including a private address unless it is necessary to
            reproduce the issue.
          </Text>
          <View style={styles.links}>
            <ListRow
              accessibilityLabel="Open NavOSS support"
              accessibilityRole="link"
              icon={{ android: 'help', ios: 'questionmark.circle.fill' }}
              onPress={() => {
                void Linking.openURL(SUPPORT_URL);
              }}
              title="Support"
              trailing="external"
            />
          </View>
        </Section>

        <Section title="Data and safety">
          <Text style={styles.body}>
            Map and search data comes from OpenStreetMap contributors. Regional context can include
            official municipal or provincial road events, enforcement cameras, ordinary traffic
            webcams, and fixed public safety facilities; each is labelled by source and type. Routes
            come from self-hosted Valhalla unless a licensed Mapbox traffic provider is explicitly
            enabled and attributed. Data and alerts may be incomplete or outdated; always follow
            posted signs and road laws.
          </Text>
          {googlePlacesLicenseInfo !== undefined && (
            <View style={styles.links}>
              <ListRow
                accessibilityLabel="Open Google Places open-source licences"
                icon={{ android: 'description', ios: 'doc.text' }}
                onPress={() => {
                  setIsGoogleLicensesVisible(true);
                }}
                title="Google Places licences"
                trailing="chevron"
              />
            </View>
          )}
        </Section>
      </BottomSheetScrollView>

      <ModalSheet
        accessibilityLabel="Google Places licences"
        detents={detents}
        onClose={() => {
          setIsGoogleLicensesVisible(false);
        }}
        visible={isGoogleLicensesVisible}
      >
        <SheetHeader
          closeLabel="Close Google Places licences"
          onClose={() => {
            setIsGoogleLicensesVisible(false);
          }}
          title="Google Places licences"
        />
        <BottomSheetScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
        >
          <Text selectable style={styles.license}>
            {googlePlacesLicenseInfo ?? 'No Google Places licences in this build.'}
          </Text>
        </BottomSheetScrollView>
      </ModalSheet>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    body: { ...typography.body, color: colors.textSecondary },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    lead: { ...typography.headline, color: colors.text },
    license: { ...typography.footnote, color: colors.textSecondary },
    links: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    section: { gap: space.md },
    sectionTitle: { ...typography.title3, color: colors.text },
  }),
);
