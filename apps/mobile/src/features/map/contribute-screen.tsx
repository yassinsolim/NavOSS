import { SymbolView } from 'expo-symbols';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { APP_TAB_BAR_HEIGHT } from '@/features/map/app-tab-bar';
import {
  CONTRIBUTION_TYPES,
  createContributionDraft,
  type ContributionDraft,
  type ContributionType,
  loadContributionDrafts,
  normalizeContributionDrafts,
  saveContributionDrafts,
} from '@/features/map/contribution-drafts';
import { submitContribution } from '@/lib/api';

interface ContributeScreenProps {
  bottomInset: number;
  safeAreaTop: number;
}

function contributionLabel(type: ContributionType): string {
  return CONTRIBUTION_TYPES.find((option) => option.id === type)?.label ?? 'Draft';
}

export function ContributeScreen({ bottomInset, safeAreaTop }: ContributeScreenProps) {
  const [drafts, setDrafts] = useState<ContributionDraft[]>([]);
  const draftsRef = useRef<ContributionDraft[]>([]);
  const [description, setDescription] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [location, setLocation] = useState('');
  const [selectedType, setSelectedType] = useState<ContributionType>('missing-place');
  const [submittingDraftId, setSubmittingDraftId] = useState<string>();

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
      Alert.alert('Draft not saved', 'This draft could not be stored on your device.');
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const submitDraft = async (draft: ContributionDraft): Promise<string | undefined> => {
    if (submittingDraftId !== undefined) return undefined;
    setSubmittingDraftId(draft.id);
    try {
      const accepted = await submitContribution({
        createdAt: draft.createdAt,
        description: draft.description,
        draftId: draft.id,
        ...(draft.location === undefined ? {} : { locationLabel: draft.location }),
        type: draft.type,
      });
      await persistDrafts((current) => current.filter((candidate) => candidate.id !== draft.id));
      return accepted.submissionId;
    } catch {
      Alert.alert(
        'Saved for retry',
        'NavOSS could not receive this feedback right now. The pending submission remains only on this device until you retry or delete it.',
      );
      return undefined;
    } finally {
      setSubmittingDraftId(undefined);
    }
  };

  const handleSubmit = async () => {
    if (description.trim().length < 5) {
      Alert.alert('Add a little more detail', 'Describe the change in at least five characters.');
      return;
    }
    const draft = createContributionDraft(selectedType, description, location);
    const saved = await persistDrafts((current) => [draft, ...current]);
    if (!saved) return;
    setDescription('');
    setLocation('');
    const submissionId = await submitDraft(draft);
    if (submissionId !== undefined) {
      Alert.alert(
        'Feedback submitted',
        `NavOSS received this anonymous beta feedback for review. Reference: ${submissionId}`,
      );
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
      style={[styles.screen, { paddingTop: safeAreaTop }]}
    >
      <View style={styles.header}>
        <Text style={styles.eyebrow}>HELP IMPROVE NAVOSS</Text>
        <Text style={styles.title}>Contribute</Text>
        <Text style={styles.subtitle}>
          Send a place, road, or route correction to the beta team.
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: APP_TAB_BAR_HEIGHT + bottomInset + 28 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.notice}>
          <SymbolView
            name={{ android: 'lock', ios: 'lock.fill' }}
            size={20}
            tintColor={NavOssColors.green}
          />
          <Text style={styles.noticeText}>
            Submissions contain the type, your description, optional place or road label, and time.
            They contain no account, device identifier, or precise coordinate. NavOSS retains
            accepted beta feedback for up to 90 days. Failed submissions stay only on this device
            for retry.
          </Text>
        </View>

        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>What changed?</Text>
          <View accessibilityRole="radiogroup" style={styles.typeGrid}>
            {CONTRIBUTION_TYPES.map((option) => {
              const selected = option.id === selectedType;
              return (
                <Pressable
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, selected }}
                  key={option.id}
                  onPress={() => {
                    setSelectedType(option.id);
                  }}
                  style={({ pressed }) => [
                    styles.typeOption,
                    selected && styles.typeOptionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <SymbolView
                    name={option.icon}
                    size={20}
                    tintColor={selected ? NavOssColors.white : NavOssColors.green}
                  />
                  <Text style={[styles.typeLabel, selected && styles.typeLabelSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.fieldLabel}>Place or road</Text>
          <TextInput
            accessibilityLabel="Place or road"
            autoCapitalize="words"
            maxLength={160}
            onChangeText={setLocation}
            placeholder="Optional location"
            placeholderTextColor={NavOssColors.muted}
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
            placeholderTextColor={NavOssColors.muted}
            style={[styles.input, styles.detailsInput]}
            textAlignVertical="top"
            value={description}
          />

          <Pressable
            accessibilityLabel="Submit feedback"
            disabled={!isHydrated || isSaving || submittingDraftId !== undefined}
            onPress={() => {
              void handleSubmit();
            }}
            style={({ pressed }) => [
              styles.saveButton,
              (!isHydrated || isSaving || submittingDraftId !== undefined) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <SymbolView
              name={{ android: 'send', ios: 'paperplane.fill' }}
              size={19}
              tintColor={NavOssColors.white}
            />
            <Text style={styles.saveButtonText}>
              {submittingDraftId === undefined ? 'Submit feedback' : 'Submitting'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.draftSection}>
          <Text style={styles.sectionTitle}>Pending submissions</Text>
          {drafts.length === 0 ? (
            <Text style={styles.emptyText}>No feedback is waiting to be submitted.</Text>
          ) : (
            <View style={styles.draftList}>
              {drafts.map((draft) => (
                <View key={draft.id} style={styles.draftRow}>
                  <View style={styles.draftCopy}>
                    <Text style={styles.draftType}>{contributionLabel(draft.type)}</Text>
                    <Text numberOfLines={2} style={styles.draftDescription}>
                      {draft.description}
                    </Text>
                    <Text style={styles.draftMeta}>
                      {draft.location === undefined ? 'No location' : draft.location} ·{' '}
                      {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(
                        new Date(draft.createdAt),
                      )}
                    </Text>
                  </View>
                  <View style={styles.draftActions}>
                    <Pressable
                      accessibilityLabel={`Retry ${contributionLabel(draft.type)} submission`}
                      disabled={isSaving || submittingDraftId !== undefined}
                      hitSlop={8}
                      onPress={() => {
                        void submitDraft(draft).then((submissionId) => {
                          if (submissionId !== undefined) {
                            Alert.alert(
                              'Feedback submitted',
                              `NavOSS received it. Reference: ${submissionId}`,
                            );
                          }
                        });
                      }}
                      style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                    >
                      <SymbolView
                        name={{ android: 'refresh', ios: 'arrow.clockwise' }}
                        size={18}
                        tintColor={NavOssColors.green}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`Delete ${contributionLabel(draft.type)} pending submission: ${draft.description.slice(0, 60)}`}
                      disabled={isSaving || submittingDraftId !== undefined}
                      hitSlop={8}
                      onPress={() => {
                        void persistDrafts((current) =>
                          current.filter((candidate) => candidate.id !== draft.id),
                        );
                      }}
                      style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                    >
                      <SymbolView
                        name={{ android: 'delete', ios: 'trash' }}
                        size={18}
                        tintColor={NavOssColors.coral}
                      />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 30,
    paddingHorizontal: 18,
    paddingTop: 20,
  },
  deleteButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  detailsInput: {
    minHeight: 118,
    paddingTop: 13,
  },
  disabled: {
    opacity: 0.5,
  },
  draftCopy: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  draftActions: {
    flexDirection: 'row',
  },
  draftDescription: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
    lineHeight: 20,
  },
  draftList: {
    borderColor: NavOssColors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  draftMeta: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 12,
    letterSpacing: 0,
  },
  draftRow: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    minHeight: 86,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  draftSection: {
    gap: 10,
  },
  draftType: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 12,
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  emptyText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
  },
  eyebrow: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 11,
    letterSpacing: 0,
  },
  fieldLabel: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    letterSpacing: 0,
    marginBottom: -5,
    marginTop: 4,
  },
  formSection: {
    gap: 12,
  },
  header: {
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 3,
    paddingBottom: 18,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  input: {
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 6,
    borderWidth: 1,
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.regular,
    fontSize: 16,
    letterSpacing: 0,
    minHeight: 50,
    paddingHorizontal: 13,
  },
  notice: {
    alignItems: 'flex-start',
    backgroundColor: NavOssColors.sky,
    borderColor: '#A8CFCA',
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 11,
    padding: 14,
  },
  noticeText: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.98 }],
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 6,
    flexDirection: 'row',
    gap: 8,
    height: 52,
    justifyContent: 'center',
    marginTop: 2,
  },
  saveButtonText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 16,
    letterSpacing: 0,
  },
  screen: {
    backgroundColor: NavOssColors.paper,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 40,
  },
  sectionTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
  subtitle: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
  },
  title: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 30,
    letterSpacing: 0,
    lineHeight: 35,
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  typeLabel: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.semibold,
    fontSize: 13,
    letterSpacing: 0,
  },
  typeLabelSelected: {
    color: NavOssColors.white,
  },
  typeOption: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 50,
    paddingHorizontal: 12,
    width: '48.5%',
  },
  typeOptionSelected: {
    backgroundColor: NavOssColors.green,
    borderColor: NavOssColors.green,
  },
});
