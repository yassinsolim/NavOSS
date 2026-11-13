import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import {
  CONTRIBUTION_TYPES,
  type ContributionDraft,
  contributionSubmission,
  type ContributionType,
  createContributionDraft,
  loadContributionDrafts,
  normalizeContributionDrafts,
  saveContributionDrafts,
} from '@/features/map/contribution-drafts';
import { TAB_BAR_HEIGHT } from '@/features/map/overlay-layout';
import { submitContribution } from '@/lib/api';
import { createThemedStyles, motion, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import { Banner, type BannerTone } from '@/ui/banner';
import { Button } from '@/ui/button';
import { Chip } from '@/ui/chip';
import { IconButton } from '@/ui/icon-button';
import { SectionTitle } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

interface ContributeScreenProps {
  bottomInset: number;
  safeAreaTop: number;
}

interface Outcome {
  message: string;
  title: string;
  tone: BannerTone;
}

function contributionLabel(type: ContributionType): string {
  return CONTRIBUTION_TYPES.find((option) => option.id === type)?.label ?? 'Draft';
}

/**
 * Beta feedback. A submission is stored on the device first and removed only once the service
 * accepts it, so a failed send is never lost and never silently retried. Outcomes are shown
 * inline, above the form, rather than as alerts.
 */
export function ContributeScreen({ bottomInset, safeAreaTop }: ContributeScreenProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [drafts, setDrafts] = useState<ContributionDraft[]>([]);
  const draftsRef = useRef<ContributionDraft[]>([]);
  const [description, setDescription] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [location, setLocation] = useState('');
  const [outcome, setOutcome] = useState<Outcome>();
  const [selectedType, setSelectedType] = useState<ContributionType>('missing-place');
  const [submittingDraftId, setSubmittingDraftId] = useState<string>();
  const busy = !isHydrated || isSaving || submittingDraftId !== undefined;

  useEffect(() => {
    let active = true;
    void loadContributionDrafts().then((storedDrafts) => {
      if (active) {
        draftsRef.current = storedDrafts;
        setDrafts(storedDrafts);
        setIsHydrated(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const persistDrafts = async (
    update: (current: ContributionDraft[]) => ContributionDraft[],
  ): Promise<boolean> => {
    if (!isHydrated || isSaving) return false;
    const previousDrafts = draftsRef.current;
    const nextDrafts = normalizeContributionDrafts(update(previousDrafts));
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setIsSaving(true);
    try {
      await saveContributionDrafts(nextDrafts);
      return true;
    } catch {
      if (draftsRef.current === nextDrafts) {
        draftsRef.current = previousDrafts;
        setDrafts(previousDrafts);
      }
      haptics.error();
      setOutcome({
        message: 'This draft could not be stored on your device.',
        title: 'Draft not saved',
        tone: 'danger',
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const submitDraft = async (draft: ContributionDraft) => {
    if (submittingDraftId !== undefined) return;
    setSubmittingDraftId(draft.id);
    try {
      const accepted = await submitContribution(contributionSubmission(draft));
      await persistDrafts((current) => current.filter((candidate) => candidate.id !== draft.id));
      haptics.success();
      setOutcome({
        message: `NavOSS received this anonymous beta feedback for review. Reference: ${accepted.submissionId}`,
        title: 'Feedback submitted',
        tone: 'info',
      });
    } catch {
      haptics.warning();
      setOutcome({
        message:
          'NavOSS could not receive this feedback right now. The pending submission remains only on this device until you retry or delete it.',
        title: 'Saved for retry',
        tone: 'warning',
      });
    } finally {
      setSubmittingDraftId(undefined);
    }
  };

  const handleSubmit = async () => {
    if (description.trim().length < 5) {
      setOutcome({
        message: 'Describe the change in at least five characters.',
        title: 'Add a little more detail',
        tone: 'warning',
      });
      return;
    }
    const draft = createContributionDraft(selectedType, description, location);
    const saved = await persistDrafts((current) => [draft, ...current]);
    if (!saved) return;
    setDescription('');
    setLocation('');
    await submitDraft(draft);
  };

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[styles.screen, { paddingTop: safeAreaTop }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardSurface}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: TAB_BAR_HEIGHT + bottomInset + space.xxl },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.eyebrow}>Help improve NavOSS</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Contribute
            </Text>
            <Text style={styles.subtitle}>
              Send a place, road, or route correction to the beta team.
            </Text>
          </View>

          {outcome !== undefined && (
            <Banner announce message={outcome.message} title={outcome.title} tone={outcome.tone} />
          )}

          <View style={styles.section}>
            <SectionTitle>What changed?</SectionTitle>
            <View accessibilityRole="radiogroup" style={styles.typeGrid}>
              {CONTRIBUTION_TYPES.map((option) => {
                const selected = option.id === selectedType;
                return (
                  <Chip
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    icon={option.icon}
                    key={option.id}
                    label={option.label}
                    onPress={() => {
                      if (!selected) haptics.selection();
                      setSelectedType(option.id);
                    }}
                    selected={selected}
                    style={styles.typeOption}
                  />
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.fieldLabel}>Place or road</Text>
            <TextInput
              accessibilityLabel="Place or road"
              autoCapitalize="words"
              maxLength={160}
              onChangeText={setLocation}
              placeholder="Optional location"
              placeholderTextColor={colors.textTertiary}
              selectionColor={colors.primary}
              style={styles.input}
              value={location}
            />
            <Text style={styles.fieldLabel}>Details</Text>
            <TextInput
              accessibilityLabel="Contribution details"
              maxLength={800}
              multiline
              onChangeText={setDescription}
              placeholder="Describe the missing place, incorrect detail, or route issue"
              placeholderTextColor={colors.textTertiary}
              selectionColor={colors.primary}
              style={[styles.input, styles.detailsInput]}
              textAlignVertical="top"
              value={description}
            />
            <Button
              accessibilityLabel="Submit feedback"
              disabled={busy}
              icon={{ android: 'send', ios: 'paperplane.fill' }}
              label={submittingDraftId === undefined ? 'Submit feedback' : 'Submitting'}
              loading={submittingDraftId !== undefined}
              onPress={() => {
                void handleSubmit();
              }}
            />
          </View>

          <Banner
            icon={{ android: 'lock', ios: 'lock.fill' }}
            message="Submissions contain the type, your description, optional place or road label, and time. They contain no account, device identifier, or precise coordinate. NavOSS retains accepted beta feedback for up to 90 days. Failed submissions stay only on this device for retry."
            tone="neutral"
          />

          <View style={styles.section}>
            <SectionTitle>Pending submissions</SectionTitle>
            {!isHydrated ? (
              <StateView title="Loading pending submissions" visual="loading" />
            ) : drafts.length === 0 ? (
              <Text style={styles.emptyText}>No feedback is waiting to be submitted.</Text>
            ) : (
              <View style={styles.draftList}>
                {drafts.map((draft) => (
                  <View key={draft.id} style={styles.draftRow}>
                    <SymbolView
                      name={{ android: 'schedule_send', ios: 'clock.badge.exclamationmark' }}
                      size={20}
                      tintColor={colors.warningText}
                    />
                    <View style={styles.draftCopy}>
                      <Text style={styles.draftType}>{contributionLabel(draft.type)}</Text>
                      <Text numberOfLines={2} style={styles.draftDescription}>
                        {draft.description}
                      </Text>
                      <Text style={styles.draftMeta}>
                        {draft.location ?? 'No location'} ·{' '}
                        {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(
                          new Date(draft.createdAt),
                        )}
                      </Text>
                    </View>
                    <IconButton
                      accessibilityLabel={`Retry ${contributionLabel(draft.type)} submission`}
                      disabled={busy}
                      icon={{ android: 'refresh', ios: 'arrow.clockwise' }}
                      onPress={() => {
                        void submitDraft(draft);
                      }}
                      variant="tonal"
                    />
                    <IconButton
                      accessibilityLabel={`Delete ${contributionLabel(draft.type)} pending submission: ${draft.description.slice(0, 60)}`}
                      disabled={busy}
                      icon={{ android: 'delete', ios: 'trash' }}
                      onPress={() => {
                        void persistDrafts((current) =>
                          current.filter((candidate) => candidate.id !== draft.id),
                        );
                      }}
                      tintColor={colors.dangerText}
                    />
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    content: { gap: space.xxl, paddingHorizontal: space.lg, paddingTop: space.lg },
    detailsInput: { minHeight: 120, paddingTop: space.md },
    draftCopy: { flex: 1, gap: 2 },
    draftDescription: { ...typography.callout, color: colors.text },
    draftList: { gap: space.sm },
    draftMeta: { ...typography.caption, color: colors.textTertiary },
    draftRow: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: space.sm,
      padding: space.md,
    },
    draftType: { ...typography.footnoteStrong, color: colors.textSecondary },
    emptyText: { ...typography.body, color: colors.textSecondary },
    eyebrow: { ...typography.eyebrow, color: colors.primaryText },
    fieldLabel: { ...typography.label, color: colors.text },
    header: { gap: space.xs },
    input: {
      ...typography.body,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderCurve: 'continuous',
      borderRadius: radius.md,
      borderWidth: 1,
      color: colors.text,
      lineHeight: undefined,
      minHeight: 50,
      paddingHorizontal: space.md,
      paddingVertical: space.md,
    },
    keyboardSurface: { flex: 1 },
    screen: {
      backgroundColor: colors.background,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    section: { gap: space.sm },
    subtitle: { ...typography.body, color: colors.textSecondary },
    title: { ...typography.largeTitle, color: colors.text },
    typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    typeOption: { flexBasis: '47%', flexGrow: 1, justifyContent: 'flex-start' },
  }),
);
