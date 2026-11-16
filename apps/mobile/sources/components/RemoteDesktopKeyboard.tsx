import * as React from 'react';
import { ActivityIndicator, Dimensions, Keyboard, type KeyboardEvent, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import type { DesktopInput } from '@/sync/remoteDesktop';
import { acknowledgeDesktopText, DESKTOP_TEXT_LIMIT, desktopTextSubmission, type DesktopTextDraft } from '@/sync/desktopKeyboardDraft';
import { remoteDesktopLabels } from '@/text/remoteDesktopLabels';

export type RemoteDesktopKeyboardProps = {
    visible: boolean;
    enabled: boolean;
    onInput: (input: DesktopInput) => Promise<boolean>;
    onClose: () => void;
    hint?: string;
    /** OS keyboard height only. The parent owns safe areas and canvas layout. */
    onKeyboardHeight?: (height: number) => void;
};

type KeyboardAttempt = {
    dispatch: RemoteDesktopKeyboardProps['onInput'];
    enterAfter: boolean;
    cancelled?: boolean;
    submitted?: DesktopTextDraft;
    prefixUnchanged?: boolean;
    resolve: (accepted: boolean) => void;
    commitTimer?: ReturnType<typeof setTimeout>;
};
type KeyInput = Extract<DesktopInput, { action: 'key' }>;
const keys: Array<{ title: string; key: string; modifiers: KeyInput['modifiers'] }> = [
    { title: 'Esc', key: 'escape', modifiers: [] }, { title: 'Tab', key: 'tab', modifiers: [] },
    { title: '↵', key: 'enter', modifiers: [] }, { title: '⌫', key: 'backspace', modifiers: [] },
    { title: '←', key: 'left', modifiers: [] }, { title: '↑', key: 'up', modifiers: [] },
    { title: '↓', key: 'down', modifiers: [] }, { title: '→', key: 'right', modifiers: [] },
    ...['a', 'c', 'v', 'x', 'z', 's', 'f'].map(key => ({ title: `⌘${key.toUpperCase()}`, key, modifiers: ['command'] as KeyInput['modifiers'] })),
    { title: '⇧⌘Z', key: 'z', modifiers: ['shift', 'command'] },
];

/** Keep this instance mounted and toggle visible so hiding never discards a draft. */
export function RemoteDesktopKeyboard({ visible, enabled, onInput, onClose, hint, onKeyboardHeight }: RemoteDesktopKeyboardProps) {
    const labels = remoteDesktopLabels();
    const input = React.useRef<TextInput>(null);
    const draft = React.useRef<DesktopTextDraft>({ text: '', revision: 0 });
    const [text, setText] = React.useState(''), [pending, setPending] = React.useState(false);
    const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
    const attempt = React.useRef<KeyboardAttempt | null>(null), nativeCommit = React.useRef<KeyboardAttempt | null>(null);
    const mounted = React.useRef(true), openingFocused = React.useRef(false);
    const latest = React.useRef({ visible, enabled, onInput, onKeyboardHeight });
    latest.current = { visible, enabled, onInput, onKeyboardHeight };

    const edit = React.useCallback((value: string) => {
        if (draft.current.text === value) return;
        const current = attempt.current;
        if (current?.submitted && !value.startsWith(current.submitted.text)) current.prefixUnchanged = false;
        draft.current = { text: value, revision: draft.current.revision + 1 };
        if (mounted.current) setText(value);
    }, []);
    const focus = React.useCallback(() => {
        if (latest.current.visible) input.current?.focus();
    }, []);
    const finish = React.useCallback((current: KeyboardAttempt, accepted: boolean) => {
        if (current.commitTimer) clearTimeout(current.commitTimer);
        if (nativeCommit.current === current) nativeCommit.current = null;
        if (attempt.current === current) {
            attempt.current = null;
            if (mounted.current) setPending(false);
        }
        current.resolve(accepted);
    }, []);

    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (nativeCommit.current) finish(nativeCommit.current, false);
        };
    }, [finish]);
    React.useEffect(() => {
        openingFocused.current = false;
        if (!visible) {
            setShortcutsOpen(false);
            if (nativeCommit.current) finish(nativeCommit.current, false);
            latest.current.onKeyboardHeight?.(0);
            return;
        }
        const frame = requestAnimationFrame(() => { openingFocused.current = true; focus(); });
        const changed = Keyboard.addListener('keyboardWillChangeFrame', (event: KeyboardEvent) => {
            const overlap = Math.max(0, Dimensions.get('screen').height - event.endCoordinates.screenY);
            latest.current.onKeyboardHeight?.(Math.min(event.endCoordinates.height, overlap));
        });
        const shown = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => latest.current.onKeyboardHeight?.(event.endCoordinates.height));
        const hidden = Keyboard.addListener('keyboardDidHide', () => latest.current.onKeyboardHeight?.(0));
        return () => { cancelAnimationFrame(frame); changed.remove(); shown.remove(); hidden.remove(); };
    }, [visible, focus, finish]);

    const submitCommitted = React.useCallback(async (current: KeyboardAttempt, value: string) => {
        if (nativeCommit.current === current) nativeCommit.current = null;
        if (current.commitTimer) clearTimeout(current.commitTimer);
        edit(value);
        const submitted = desktopTextSubmission(draft.current);
        // Refocus after native onEndEditing has committed marked Chinese text.
        requestAnimationFrame(focus);
        if (!latest.current.enabled || !latest.current.visible || latest.current.onInput !== current.dispatch
            || (!submitted && (value.length > 0 || !current.enterAfter))) { finish(current, false); return; }
        try {
            if (submitted) {
                current.submitted = submitted; current.prefixUnchanged = true;
                const accepted = await current.dispatch({ action: 'text', text: submitted.text });
                if (!accepted) { finish(current, false); return; }
                edit(acknowledgeDesktopText(draft.current, submitted, current.prefixUnchanged));
            }
            if (current.enterAfter) {
                if (current.cancelled || !latest.current.visible || !latest.current.enabled || latest.current.onInput !== current.dispatch) { finish(current, false); return; }
                finish(current, await current.dispatch({ action: 'key', key: 'enter', modifiers: [] }));
            } else finish(current, true);
        } catch { finish(current, false); }
    }, [edit, finish, focus]);

    const submitText = React.useCallback((enterAfter = false): Promise<boolean> => {
        if (!latest.current.visible || !latest.current.enabled || attempt.current) return Promise.resolve(false);
        return new Promise(resolve => {
            const current: KeyboardAttempt = { dispatch: latest.current.onInput, enterAfter, resolve };
            attempt.current = current; setPending(true);
            if (input.current?.isFocused()) {
                nativeCommit.current = current;
                // An absent final native event is not permission to send marked text.
                current.commitTimer = setTimeout(() => { finish(current, false); focus(); }, 1000);
                input.current.blur();
            } else void submitCommitted(current, draft.current.text);
        });
    }, [finish, focus, submitCommitted]);
    const sendKey = React.useCallback(async (key: KeyInput): Promise<boolean> => {
        if (key.key === 'enter' && !key.modifiers.length) return submitText(true);
        if (!latest.current.visible || !latest.current.enabled || attempt.current) return false;
        return new Promise(resolve => {
            const current: KeyboardAttempt = { dispatch: latest.current.onInput, enterAfter: false, resolve };
            attempt.current = current; setPending(true);
            void current.dispatch(key).then(accepted => finish(current, accepted), () => finish(current, false));
        });
    }, [finish, submitText]);
    const close = () => {
        latest.current.visible = false;
        if (attempt.current) attempt.current.cancelled = true;
        if (nativeCommit.current) finish(nativeCommit.current, false);
        input.current?.blur(); Keyboard.dismiss(); latest.current.onKeyboardHeight?.(0); onClose();
    };

    if (!visible) return null;
    const tooLong = text.length > DESKTOP_TEXT_LIMIT;
    const message = [hint, tooLong ? `${text.length} / ${DESKTOP_TEXT_LIMIT}` : null].filter(Boolean).join(' · ');
    return <BlurView testID="desktop-keyboard-panel" tint="dark" intensity={24} style={styles.panel}>
        <View style={styles.inputRow}>
            <TextInput ref={input} testID="desktop-text-input" accessibilityLabel={labels.text} placeholder={labels.text}
                value={text} onChangeText={edit} autoFocus multiline submitBehavior="newline" autoCorrect={false}
                autoCapitalize="none" spellCheck={false} textContentType="none" keyboardAppearance="dark"
                placeholderTextColor="#80929C" selectionColor="#88C9E5" style={styles.input}
                onLayout={() => { if (!openingFocused.current) { openingFocused.current = true; focus(); } }}
                onEndEditing={event => { const current = nativeCommit.current; if (current) void submitCommitted(current, event.nativeEvent.text); }} />
            <Pressable testID="desktop-type" accessibilityRole="button" accessibilityLabel={labels.send}
                accessibilityState={{ disabled: !enabled || pending || !text || tooLong, busy: pending }} disabled={!enabled || pending || !text || tooLong}
                onPress={() => submitText()} style={({ pressed }) => [styles.send, pressed && styles.pressed, (!enabled || pending || !text || tooLong) && styles.disabled]}>
                {pending ? <ActivityIndicator size="small" color="#88C9E5" /> : <Ionicons name="arrow-up" size={21} color="#88C9E5" />}
            </Pressable>
            <Pressable testID="desktop-keyboard-shortcuts" accessibilityRole="button" accessibilityLabel={labels.controls}
                accessibilityState={{ expanded: shortcutsOpen }} onPress={() => setShortcutsOpen(value => !value)}
                style={({ pressed }) => [styles.key, shortcutsOpen && styles.selected, pressed && styles.pressed]}>
                <Ionicons name="ellipsis-horizontal" size={22} color={shortcutsOpen ? '#88C9E5' : '#E8EEF4'} />
            </Pressable>
            <Pressable testID="desktop-keyboard-close" accessibilityRole="button" accessibilityLabel={labels.close} onPress={close}
                style={({ pressed }) => [styles.key, pressed && styles.pressed]}><Ionicons name="chevron-down" size={22} color="#E8EEF4" /></Pressable>
        </View>
        <Text numberOfLines={1} accessible={!!message} accessibilityLiveRegion={message ? 'polite' : 'none'} style={[styles.hint, tooLong && styles.limit]}>{message}</Text>
        {shortcutsOpen ? <ScrollView horizontal keyboardShouldPersistTaps="always" keyboardDismissMode="none" showsHorizontalScrollIndicator={false}
            style={styles.shortcutStrip} contentContainerStyle={styles.keyRow}>
            {keys.map(key => <Pressable key={key.title} testID={`desktop-key-${key.key}-${key.modifiers.join('-') || 'plain'}`}
                accessibilityRole="button" accessibilityLabel={key.modifiers.length ? key.title.replace('⌘', 'Command ').replace('⇧', 'Shift ') : key.key}
                accessibilityState={{ disabled: !enabled || pending }} disabled={!enabled || pending}
                onPress={() => sendKey({ action: 'key', key: key.key, modifiers: key.modifiers })}
                style={({ pressed }) => [styles.key, pressed && styles.pressed, (!enabled || pending) && styles.disabled]}><Text style={styles.keyText}>{key.title}</Text></Pressable>)}
        </ScrollView> : null}
    </BlurView>;
}

const styles = StyleSheet.create({
    panel: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 16, overflow: 'hidden', backgroundColor: 'rgba(16,25,34,0.76)', borderWidth: 1, borderColor: 'rgba(232,238,244,0.14)' },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    input: { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 80, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, color: '#E8EEF4', backgroundColor: 'rgba(2,4,6,0.45)', fontSize: 16 },
    send: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(136,201,229,0.13)' },
    keyRow: { gap: 6 },
    shortcutStrip: { marginTop: 6 },
    key: { minWidth: 44, height: 44, paddingHorizontal: 10, borderRadius: 10, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(232,238,244,0.06)' },
    keyText: { color: '#E8EEF4', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : undefined },
    hint: { minHeight: 16, lineHeight: 16, color: '#80929C', fontSize: 12, paddingHorizontal: 12 },
    limit: { color: '#F2B765' },
    selected: { backgroundColor: 'rgba(136,201,229,0.13)' },
    pressed: { backgroundColor: 'rgba(136,201,229,0.24)' },
    disabled: { opacity: 0.4 },
});
