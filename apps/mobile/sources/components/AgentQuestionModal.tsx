import * as React from 'react';
import * as ReactNative from 'react-native';
const {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    TextInput,
    View,
} = ReactNative;
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    buildAnswers,
    canSubmit,
    isQuestionAnswered,
    toggleOption,
    type AgentQuestionDraft,
    type PendingAgentForm,
} from '@/sync/agentCommunications';
import { sessionAnswerQuestion, sessionCancelCommunication } from '@/sync/ops';
import { BridgeRpcUnconfirmedError } from '@/sync/noninvasiveRpcJournal';
import { storage, useSession, useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';

interface AgentQuestionModalProps {
    pending: PendingAgentForm;
    sessionId: string;
    visible: boolean;
    onClose: () => void;
}

/**
 * Full-screen form for the questions an agent is waiting on. Each question
 * offers its options as checkboxes and, when the agent allows it, a field for
 * an answer it did not think of.
 */
export function AgentQuestionModal({ pending, sessionId, visible, onClose }: AgentQuestionModalProps) {
    const session = useSession(sessionId), socketConnected = useSocketStatus().status === 'connected';
    const writesBlocked = nativeWriteConnectionBlocked(session?.metadata, socketConnected);
    const blockedNow = () => nativeWriteConnectionBlocked(storage.getState().sessions[sessionId]?.metadata ?? session?.metadata, apiSocket.peerConnected());
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const [drafts, setDrafts] = React.useState<Record<string, AgentQuestionDraft>>({});
    const [submitting, setSubmitting] = React.useState(false);
    const submittingRef = React.useRef(false);
    const generation = React.useRef(0);
    const [error, setError] = React.useState<string | null>(null);
    const [unconfirmed, setUnconfirmed] = React.useState(false);

    // Start from a clean form every time the modal opens for a new request.
    React.useEffect(() => {
        generation.current++;
        submittingRef.current = false; setSubmitting(false);
        if (visible) {
            setDrafts({});
            setError(null);
            setUnconfirmed(false);
        }
        return () => { generation.current++; };
    }, [sessionId, pending.id, visible]);

    const draftFor = React.useCallback(
        (questionId: string) => drafts[questionId] ?? { options: [], custom: '' },
        [drafts],
    );

    const handleToggle = React.useCallback((questionId: string, label: string, multiSelect: boolean) => {
        setDrafts(previous => ({
            ...previous,
            [questionId]: toggleOption(previous[questionId] ?? { options: [], custom: '' }, label, multiSelect),
        }));
    }, []);

    const handleCustomChange = React.useCallback((questionId: string, custom: string) => {
        setDrafts(previous => ({
            ...previous,
            [questionId]: { ...(previous[questionId] ?? { options: [], custom: '' }), custom },
        }));
    }, []);

    const ready = canSubmit(pending.questions, drafts);

    const handleSubmit = React.useCallback(async () => {
        if (!ready || submittingRef.current || blockedNow()) return;
        submittingRef.current = true;
        const owner = generation.current;
        setSubmitting(true);
        setError(null);
        try {
            await sessionAnswerQuestion(
                sessionId,
                pending.id,
                buildAnswers(pending.questions, drafts),
                pending.kind,
            );
            if (owner === generation.current) onClose();
        } catch (submitError) {
            if (owner !== generation.current) return;
            // 未确认只允许查询原回执；保留原答案，不能让改选或关闭触发另一条原生操作。
            setUnconfirmed(submitError instanceof BridgeRpcUnconfirmedError);
            setError(submitError instanceof BridgeRpcUnconfirmedError ? t('agentQuestion.replyUnconfirmed')
                : submitError instanceof Error ? submitError.message : t('agentQuestion.submitFailed'));
        } finally {
            if (owner === generation.current) { submittingRef.current = false; setSubmitting(false); }
        }
    }, [drafts, onClose, pending, ready, sessionId, submitting, session?.metadata]);

    const handleDismiss = React.useCallback(async () => {
        if (submitting) return;
        onClose();
        if (unconfirmed || blockedNow()) return;
        try {
            await sessionCancelCommunication(sessionId, pending.id, pending.kind);
        } catch {
            // The agent re-asks if the dismissal never lands; nothing to show here.
        }
    }, [onClose, pending.id, pending.kind, sessionId, submitting, unconfirmed, session?.metadata]);

    const rn = ReactNative as Record<string, any>;
    const KeyboardContainer: React.ComponentType<any> = Object.prototype.hasOwnProperty.call(rn, 'KeyboardAvoidingView') && rn.KeyboardAvoidingView
        ? rn.KeyboardAvoidingView
        : View;
    const isAndroid = Object.prototype.hasOwnProperty.call(rn, 'Platform') && rn.Platform?.OS === 'android';
    const keyboardBehavior = Object.prototype.hasOwnProperty.call(rn, 'Platform') && rn.Platform?.OS === 'ios' ? 'padding' : undefined;
    const [androidImeHeight, setAndroidImeHeight] = React.useState(0);

    React.useEffect(() => {
        if (!visible || !isAndroid) {
            setAndroidImeHeight(0);
            return;
        }
        const keyboard = rn.Keyboard;
        if (typeof keyboard?.addListener !== 'function') return;
        const onShow = keyboard.addListener('keyboardDidShow', (event: { endCoordinates?: { height?: number; screenY?: number } }) => {
            const height = Math.max(0, event?.endCoordinates?.height ?? 0);
            const screenHeight = rn.Dimensions?.get?.('screen')?.height;
            const screenY = event?.endCoordinates?.screenY;
            const overlap = typeof screenY === 'number' && typeof screenHeight === 'number' && screenHeight > 0 && screenY >= 0 && screenY <= screenHeight
                ? Math.max(height, screenHeight - screenY)
                : height > 0 ? height + safeArea.bottom : 0;
            setAndroidImeHeight(overlap);
        });
        const onHide = keyboard.addListener('keyboardDidHide', () => {
            setAndroidImeHeight(0);
        });
        return () => {
            onShow?.remove?.();
            onHide?.remove?.();
        };
    }, [visible, isAndroid, safeArea.bottom]);

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="fullScreen"
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={handleDismiss}
        >
            <View testID="codelync-question-modal" style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={styles.header}>
                    <Pressable
                        testID="codelync-question-close"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        accessibilityState={{ disabled: submitting }}
                        style={styles.headerSideButton}
                        onPress={handleDismiss}
                        hitSlop={12}
                        disabled={submitting}
                    >
                        <Text style={[styles.headerAction, submitting && styles.actionDisabled]}>{t('common.cancel')}</Text>
                    </Pressable>
                    <Text style={styles.headerTitle} numberOfLines={1}>{t('agentQuestion.title')}</Text>
                    <View style={styles.headerSpacer} />
                </View>

                <KeyboardContainer
                    testID="codelync-question-keyboard-avoiding"
                    behavior={keyboardBehavior}
                    style={styles.keyboardAvoiding}
                >
                    <ScrollView
                        style={styles.scroll}
                        contentContainerStyle={[styles.scrollContent, { paddingBottom: 28 }]}
                        keyboardShouldPersistTaps="handled"
                        automaticallyAdjustKeyboardInsets={keyboardBehavior === 'padding'}
                    >
                        {pending.questions.map((question, index) => {
                            const draft = draftFor(question.id);
                            const multiSelect = question.multiSelect === true;
                            const answered = isQuestionAnswered(question, drafts[question.id]);

                            return (
                                <View testID={`codelync-question-${question.id}`} key={question.id} style={styles.questionBlock}>
                                    <View style={styles.headerChipRow}>
                                        <View style={styles.headerChip}>
                                            <Text style={styles.headerChipText}>{question.header}</Text>
                                        </View>
                                        {!answered && <View style={styles.requiredDot} />}
                                    </View>
                                    <Text style={styles.questionText}>{question.question}</Text>
                                    {multiSelect && (
                                        <Text style={styles.hintText}>{t('agentQuestion.chooseMultiple')}</Text>
                                    )}

                                    {question.options.map((option, optionIndex) => {
                                        const selected = draft.options.includes(option.label);
                                        return (
                                            <Pressable
                                                key={option.label}
                                                testID={`codelync-question-option-${question.id}-${optionIndex}`}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected, disabled: submitting || unconfirmed }}
                                                style={[styles.option, selected && styles.optionSelected]}
                                                onPress={() => handleToggle(question.id, option.label, multiSelect)}
                                                disabled={submitting || unconfirmed}
                                            >
                                                <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                                                    {selected && (
                                                        <Ionicons name="checkmark" size={14} color="#fff" />
                                                    )}
                                                </View>
                                                <View style={styles.optionText}>
                                                    <Text style={styles.optionLabel}>{option.label}</Text>
                                                    {option.description ? (
                                                        <Text style={styles.optionDescription}>
                                                            {option.description}
                                                        </Text>
                                                    ) : null}
                                                </View>
                                            </Pressable>
                                        );
                                    })}

                                    {question.allowCustom !== false && (
                                        <View style={styles.customBlock}>
                                            <Text style={styles.customLabel}>{t('agentQuestion.ownAnswer')}</Text>
                                            <TextInput
                                                testID={`codelync-question-custom-${question.id}`}
                                                style={styles.customInput}
                                                value={draft.custom}
                                                onChangeText={value => handleCustomChange(question.id, value)}
                                                placeholder={t('agentQuestion.ownAnswerPlaceholder')}
                                                placeholderTextColor={theme.colors.textSecondary}
                                                multiline
                                                editable={!submitting && !unconfirmed}
                                                // Focus the first question's field so the keyboard is
                                                // ready for a written answer without another tap.
                                                autoFocus={index === 0 && question.options.length === 0}
                                            />
                                        </View>
                                    )}
                                </View>
                            );
                        })}

                        {error && (
                            <Text
                                testID="codelync-question-error"
                                accessibilityLiveRegion="polite"
                                style={[
                                    styles.errorText,
                                    { color: theme.colors.warningCritical ?? theme.colors.textDestructive ?? (theme.dark ? '#FF453A' : '#FF3B30') },
                                ]}
                            >
                                {error}
                            </Text>
                        )}
                    </ScrollView>

                    <View style={[styles.footer, { paddingBottom: (isAndroid && androidImeHeight > 0 ? androidImeHeight : safeArea.bottom) + 12 }]}>
                        <Pressable
                            testID="codelync-question-submit"
                            accessibilityRole="button"
                            accessibilityLabel={t(unconfirmed ? 'agentQuestion.checkResult' : 'agentQuestion.submit')}
                            accessibilityState={{ disabled: !ready || submitting || writesBlocked, busy: submitting }}
                            style={[styles.submit, (!ready || submitting || writesBlocked) && styles.submitDisabled]}
                            onPress={handleSubmit}
                            disabled={!ready || submitting || writesBlocked}
                        >
                            {submitting ? (
                                <ActivityIndicator color="#fff" />
                            ) : (
                                <Text style={styles.submitText}>{t(unconfirmed ? 'agentQuestion.checkResult' : 'agentQuestion.submit')}</Text>
                            )}
                        </Pressable>
                    </View>
                </KeyboardContainer>
            </View>
        </Modal>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        minHeight: 52,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    headerSideButton: {
        minWidth: 80,
        minHeight: 44,
        justifyContent: 'center',
        alignItems: 'flex-start',
    },
    headerAction: {
        fontSize: 16,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
    actionDisabled: {
        opacity: 0.45,
    },
    headerTitle: {
        flex: 1,
        textAlign: 'center',
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerSpacer: {
        minWidth: 80,
    },
    keyboardAvoiding: {
        flex: 1,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 16,
        gap: 28,
    },
    questionBlock: {
        gap: 8,
    },
    headerChipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    headerChipText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    requiredDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.dark ? '#FF9F0A' : '#FF9500',
    },
    questionText: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    hintText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    option: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        padding: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    optionSelected: {
        borderColor: theme.colors.radio?.active ?? theme.colors.textLink,
    },
    checkbox: {
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: theme.dark ? '#98989D' : (theme.colors.textSecondary ?? '#6C6C70'),
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    checkboxSelected: {
        backgroundColor: theme.colors.radio?.active ?? theme.colors.textLink,
        borderColor: theme.colors.radio?.active ?? theme.colors.textLink,
    },
    optionText: {
        flex: 1,
        gap: 2,
    },
    optionLabel: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    customBlock: {
        gap: 8,
        marginTop: 6,
    },
    customLabel: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    customInput: {
        minHeight: 48,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.dark ? 'rgba(255, 255, 255, 0.16)' : (theme.colors.divider ?? theme.colors.textSecondary),
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 15,
        color: theme.colors.text,
        textAlignVertical: 'top',
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.warningCritical ?? theme.colors.textDestructive ?? (theme.dark ? '#FF453A' : '#FF3B30'),
        ...Typography.default(),
    },
    footer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    submit: {
        height: 50,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.radio?.active ?? theme.colors.textLink,
    },
    submitDisabled: {
        opacity: 0.4,
    },
    submitText: {
        fontSize: 16,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
}));
