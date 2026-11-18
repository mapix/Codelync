import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { storage } from '@/sync/storage';
import { useDraft } from '@/hooks/useDraft';
import { runNoninvasiveRpc } from '@/sync/noninvasiveRpc';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { Modal } from '@/modal';
import { NativeWindowViewer } from './NativeWindowViewer';
import { NativeSourceBanner } from './NativeSourceBanner';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type NativeControl = { nodeId: string; role?: string; subrole?: string; title?: string; label?: string; description?: string; value?: string; text?: Record<string, string>; enabled?: boolean; editable?: boolean; valueSettable?: boolean; emptyEditable?: boolean; editableValueTruncated?: boolean; secureValueRedacted?: boolean; actions?: string[] };

export function NativeWindowPanel({ sessionId, topInset = 100 }: { sessionId: string; topInset?: number }) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const session = useSession(sessionId);
    const [text, onChangeText] = React.useState(() => storage.getState().sessions[sessionId]?.draft ?? '');
    useDraft(sessionId, text, onChangeText);
    const raw = session?.agentState?.windowObservation;
    const observation = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    const stamp = observation.captureStamp;
    const ref = typeof observation.imageRef === 'string' ? observation.imageRef : undefined;
    const bounds = observation.bounds ?? stamp?.bounds;
    const { uri, loading, error: imageError } = useAttachmentImage(sessionId, ref);
    const controls: NativeControl[] = Array.isArray(observation.controls) ? observation.controls.filter((item: unknown) => item && typeof item === 'object' && typeof (item as NativeControl).nodeId === 'string') : [];
    const [selected, setSelected] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const connected = session?.metadata?.bridge?.sourceStatus === 'connected';
    const canControl = connected && !!stamp && session?.metadata?.capabilities?.rpcMethods?.includes('window-control') === true;
    const editable = controls.filter(c => !c.secureValueRedacted && c.subrole !== 'AXSecureTextField' && !c.editableValueTruncated && c.valueSettable !== false
        && (c.editable || /Text(Field|Area|View)|ComboBox/i.test(c.role ?? '')) && (c.emptyEditable === true || c.text?.value !== undefined && !c.text.value.trim()));
    const actionable = controls.filter(c => /Button|CheckBox|PopUp|MenuItem|RadioButton/i.test(c.role ?? '') || c.actions?.includes('press'));
    React.useEffect(() => { if (selected && !editable.some(c => c.nodeId === selected)) setSelected(null); }, [selected, controls]);
    const action = async (name: string, extra: Record<string, unknown> = {}) => {
        if (!canControl || busy) return;
        setBusy(true); setError(false);
        try { await runNoninvasiveRpc(sessionId, 'window-control', { action: name, payload: { captureStamp: stamp, runtimeGeneration: stamp?.runtimeGeneration ?? observation.runtimeGeneration, windowGeneration: stamp?.windowGeneration ?? observation.windowGeneration, ...extra } }); }
        catch { setError(true); }
        finally { setBusy(false); }
    };
    const label = (c: NativeControl) => c.title || c.label || c.description || c.text?.title || c.text?.description || c.value || c.role || t('windowControl.control');
    const buttonStyle = {
        minHeight: 44,
        justifyContent: 'center' as const,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    };
    const font = { color: theme.colors.text, ...Typography.default() };
    const fillDisabled = !canControl || busy || !selected || !text.trim();
    return <ScrollView
        testID="codelync-window-panel"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
            paddingTop: topInset + 16,
            paddingBottom: Math.max(24, (insets.bottom ?? 0) + 16),
            paddingLeft: Math.max(16, insets.left ?? 0),
            paddingRight: Math.max(16, insets.right ?? 0),
            gap: 14,
        }}
    >
        {!connected && <NativeSourceBanner sessionId={sessionId} />}
        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('windowControl.sharedWindow')}</Text>
        {uri && ref ? <Pressable accessibilityRole="button" accessibilityLabel={t('imagePreview.open')} onPress={() => Modal.show({ component: NativeWindowViewer, props: { sessionId } })}>
            <Image source={{ uri }} contentFit="contain" style={{ width: '100%', aspectRatio: bounds?.width && bounds?.height ? bounds.width / bounds.height : 4 / 3, borderRadius: 12 }} />
        </Pressable> : <View style={{ padding: 36, alignItems: 'center' }}>{loading ? <ActivityIndicator /> : <Text style={font}>{imageError ? t('imagePreview.loadFailed') : t('windowControl.waitingImage')}</Text>}</View>}
        {canControl && <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} onPress={() => action('activate')} disabled={busy} style={{ ...buttonStyle, opacity: busy ? 0.45 : 1 }}><Text style={font}>{t('windowControl.showWindow')}</Text></Pressable>}
        {error && <Text accessibilityRole="alert" style={{ color: theme.colors.warningCritical ?? theme.colors.textDestructive }}>{t('windowControl.unconfirmed')}</Text>}
        {observation.textInputAvailable === true && <>
            <Text style={font}>{t('windowControl.chooseInput')}</Text>
            {editable.map(c => {
                const itemDisabled = !canControl || busy || c.enabled === false;
                return <Pressable
                    key={c.nodeId}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: itemDisabled, selected: selected === c.nodeId }}
                    onPress={() => setSelected(c.nodeId)}
                    disabled={itemDisabled}
                    style={{
                        ...buttonStyle,
                        opacity: itemDisabled ? 0.45 : 1,
                        borderWidth: selected === c.nodeId ? 1 : StyleSheet.hairlineWidth,
                        borderColor: selected === c.nodeId ? theme.colors.text : theme.colors.divider,
                    }}
                >
                    <Text numberOfLines={2} style={font}>{label(c)}</Text>
                </Pressable>;
            })}
            <TextInput testID="codelync-window-draft" multiline value={text} onChangeText={onChangeText} placeholder={t('windowControl.draft')} placeholderTextColor={theme.colors.textSecondary} style={{ ...buttonStyle, ...font, minHeight: 80, justifyContent: undefined }} />
            <Pressable accessibilityRole="button" testID="codelync-fill-input" accessibilityState={{ disabled: fillDisabled, busy }} disabled={fillDisabled} onPress={() => action('type', { nodeId: selected, text })} style={{ ...buttonStyle, opacity: fillDisabled ? 0.45 : 1 }}><Text style={font}>{t('windowControl.fillInput')}</Text></Pressable>
        </>}
        <Text style={font}>{t('windowControl.controls')}</Text>
        {actionable.slice(0, 80).map(c => {
            const controlDisabled = !canControl || busy || c.enabled === false;
            return <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: controlDisabled, busy }}
                key={c.nodeId}
                disabled={controlDisabled}
                onPress={() => action('press', { nodeId: c.nodeId })}
                style={{ ...buttonStyle, opacity: controlDisabled ? 0.45 : 1 }}
            >
                <Text numberOfLines={2} style={font}>{label(c)}</Text>
            </Pressable>;
        })}
    </ScrollView>;
}
