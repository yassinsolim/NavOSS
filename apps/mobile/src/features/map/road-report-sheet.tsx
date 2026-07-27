import { SymbolView } from 'expo-symbols';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { ROAD_REPORT_TYPES, type RoadReportType } from '@/features/map/road-report-drafts';

interface RoadReportSheetProps {
  bottomInset: number;
  isSaving: boolean;
  onCancel: () => void;
  onSelect: (type: RoadReportType) => void;
  visible: boolean;
}

export function RoadReportSheet({
  bottomInset,
  isSaving,
  onCancel,
  onSelect,
  visible,
}: RoadReportSheetProps) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onCancel}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Cancel report" onPress={onCancel} style={styles.backdrop} />
        <View style={[styles.sheet, { paddingBottom: Math.max(bottomInset, 18) }]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>ROAD REPORT</Text>
              <Text style={styles.title}>What did you pass?</Text>
            </View>
            <Pressable
              accessibilityLabel="Cancel report"
              hitSlop={8}
              onPress={onCancel}
              style={styles.closeButton}
            >
              <SymbolView
                name={{ android: 'close', ios: 'xmark' }}
                size={20}
                tintColor={NavOssColors.muted}
              />
            </Pressable>
          </View>

          <View accessibilityRole="radiogroup" style={styles.options}>
            {ROAD_REPORT_TYPES.map((type) => (
              <Pressable
                accessibilityLabel={`Report ${type.label}`}
                accessibilityRole="button"
                disabled={isSaving}
                key={type.id}
                onPress={() => {
                  onSelect(type.id);
                }}
                style={({ pressed }) => [
                  styles.option,
                  isSaving && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.optionIcon}>
                  <SymbolView name={type.icon} size={23} tintColor={NavOssColors.asphalt} />
                </View>
                <Text style={styles.optionLabel}>{type.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.notice}>
            <SymbolView
              name={{ android: 'science', ios: 'flask.fill' }}
              size={18}
              tintColor={NavOssColors.green}
            />
            <Text style={styles.noticeText}>
              Testing mode: this report expires in two hours, stays on this phone, and is not shown
              to other drivers yet. Report only while stopped or as a passenger.
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  closeButton: {
    alignItems: 'center',
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  disabled: {
    opacity: 0.5,
  },
  eyebrow: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 11,
    letterSpacing: 0,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  notice: {
    alignItems: 'flex-start',
    backgroundColor: NavOssColors.sky,
    borderColor: '#A8CFCA',
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    padding: 12,
  },
  noticeText: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 18,
  },
  option: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 6,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    gap: 7,
    height: 88,
    justifyContent: 'center',
    minWidth: 0,
  },
  optionIcon: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sun,
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  optionLabel: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 13,
    letterSpacing: 0,
    textAlign: 'center',
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  overlay: {
    backgroundColor: 'rgba(27,37,38,0.42)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.98 }],
  },
  sheet: {
    backgroundColor: NavOssColors.paper,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    gap: 18,
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  title: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 23,
    letterSpacing: 0,
  },
});
