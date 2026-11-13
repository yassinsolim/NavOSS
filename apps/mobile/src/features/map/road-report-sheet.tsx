import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  communityReportLabel,
  type CommunityFeatureState,
  reportSheetNotice,
} from '@/features/community/community';
import { ShareReportsConsent } from '@/features/community/community-sheets';
import { ROAD_REPORT_TYPES, type RoadReportType } from '@/features/map/road-report-drafts';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Banner } from '@/ui/banner';
import { Button } from '@/ui/button';
import { PressableScale } from '@/ui/pressable-scale';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';
import { SwitchRow } from '@/ui/switch-row';

interface RoadReportSheetProps {
  isSaving: boolean;
  /** A report near Home/Work or a trip end is waiting for "Keep private" or "Share anyway". */
  nearPrivatePlace: RoadReportType | undefined;
  onCancel: () => void;
  onKeepPrivate: () => void;
  onSelect: (type: RoadReportType) => void;
  onSetShareRoadReports: (enabled: boolean) => void;
  onShareAnyway: () => void;
  sharing: { availability: CommunityFeatureState; enabled: boolean };
  visible: boolean;
}

/**
 * The report picker: eight large targets, one tap to record. The notice states exactly what
 * happens to the report. Sharing is off until the driver reads what it means and turns it on;
 * with it off, unavailable or failing, a report is a private draft exactly as before.
 */
export function RoadReportSheet({
  isSaving,
  nearPrivatePlace,
  onCancel,
  onKeepPrivate,
  onSelect,
  onSetShareRoadReports,
  onShareAnyway,
  sharing,
  visible,
}: RoadReportSheetProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [consentVisible, setConsentVisible] = useState(false);
  if (!visible && consentVisible) setConsentVisible(false);
  const sharingLive = sharing.availability === 'live';
  const shareSwitchShown = sharingLive && nearPrivatePlace === undefined;

  return (
    <ModalSheet
      accessibilityLabel="Road report"
      detents={['content']}
      onClose={onCancel}
      visible={visible}
    >
      <View style={{ paddingBottom: Math.max(insets.bottom, space.lg) }}>
        <SheetHeader
          closeLabel="Cancel report"
          eyebrow={sharingLive && sharing.enabled ? 'Report to drivers' : 'Road report'}
          onClose={onCancel}
          title={
            nearPrivatePlace !== undefined
              ? 'Share this report?'
              : consentVisible
                ? 'Share road reports with other drivers?'
                : 'What did you pass?'
          }
        />
        {nearPrivatePlace !== undefined ? (
          <View style={styles.panel}>
            <Text style={styles.panelBody}>
              This is close to your saved Home or Work, or to your trip’s start, destination or a
              stop. A shared {communityReportLabel(nearPrivatePlace).toLocaleLowerCase('en-CA')}{' '}
              report would show other drivers an approximate location near it.
            </Text>
            <Button
              disabled={isSaving}
              label="Keep it private"
              onPress={onKeepPrivate}
              size="driving"
            />
            <Button
              disabled={isSaving}
              label="Share anyway"
              loading={isSaving}
              onPress={onShareAnyway}
              variant="secondary"
            />
          </View>
        ) : consentVisible ? (
          <View style={styles.panel}>
            <ShareReportsConsent
              onAccept={() => {
                setConsentVisible(false);
                onSetShareRoadReports(true);
              }}
              onDecline={() => {
                setConsentVisible(false);
              }}
              showTitle={false}
            />
          </View>
        ) : (
          <>
            <View style={styles.options}>
              {ROAD_REPORT_TYPES.map((type) => (
                <PressableScale
                  accessibilityLabel={`Report ${type.label}`}
                  accessibilityRole="button"
                  disabled={isSaving}
                  key={type.id}
                  onPress={() => {
                    onSelect(type.id);
                  }}
                  style={[styles.option, isSaving && styles.disabled]}
                >
                  <View style={styles.optionIcon}>
                    <SymbolView name={type.icon} size={24} tintColor={colors.onSun} />
                  </View>
                  <Text numberOfLines={2} style={styles.optionLabel}>
                    {type.label}
                  </Text>
                </PressableScale>
              ))}
            </View>
            {shareSwitchShown && (
              <View style={styles.shareCard}>
                <SwitchRow
                  detail={
                    sharing.enabled
                      ? 'Other drivers see your reports'
                      : 'Off: reports stay on this iPhone'
                  }
                  disabled={isSaving}
                  label="Share road reports"
                  onValueChange={(next) => {
                    if (next) setConsentVisible(true);
                    else onSetShareRoadReports(false);
                  }}
                  value={sharing.enabled}
                />
              </View>
            )}
            <Banner
              icon={
                sharingLive && sharing.enabled
                  ? { android: 'groups', ios: 'person.2.fill' }
                  : { android: 'lock', ios: 'lock.fill' }
              }
              message={reportSheetNotice(sharing)}
              style={styles.notice}
            />
          </>
        )}
      </View>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    disabled: { opacity: 0.45 },
    notice: { marginHorizontal: space.lg, marginTop: space.md },
    option: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      flexBasis: '22%',
      flexGrow: 1,
      gap: space.sm,
      minHeight: 104,
      paddingHorizontal: space.xs,
      paddingVertical: space.md,
    },
    optionIcon: {
      alignItems: 'center',
      backgroundColor: colors.sun,
      borderRadius: radius.pill,
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
    optionLabel: { ...typography.footnoteStrong, color: colors.text, textAlign: 'center' },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg },
    panel: { gap: space.md, paddingHorizontal: space.lg },
    panelBody: { ...typography.body, color: colors.text },
    shareCard: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      marginHorizontal: space.lg,
      marginTop: space.md,
      paddingHorizontal: space.lg,
    },
  }),
);
