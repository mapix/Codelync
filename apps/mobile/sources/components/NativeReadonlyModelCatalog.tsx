import * as React from 'react';
import { AppState, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Session, NativeModelControlScope } from '@/sync/storageTypes';
import { readNativeModelControlScope, nativeModelControlScopesEqual } from '@/utils/nativeModelControls';
import { getCurrentAppState } from '@/sync/apiSocket';
import { getCurrentLanguage, t } from '@/text';
import { codelyncTaskLabels } from '@/text/codelyncTaskLabels';
import { Typography } from '@/constants/Typography';

export function NativeReadonlyModelCatalog({ session, captured, active, onClose }: {
    session: Session | null; captured: NativeModelControlScope; active: boolean; onClose(): void;
}) {
    const current = readNativeModelControlScope(session), model = session?.metadata?.nativeControls?.model;
    const [foreground, setForeground] = React.useState(getCurrentAppState() === 'active');
    React.useEffect(() => { const listener = AppState.addEventListener('change', state => setForeground(state === 'active')); return () => listener.remove(); }, []);
    const visible = active && foreground && !!current && nativeModelControlScopesEqual(current, captured)
        && model?.catalogAvailable === true && !!model.models.length;
    React.useEffect(() => { if (!visible) onClose(); }, [visible, onClose]);
    const { theme } = useUnistyles();
    const closeLabel = codelyncTaskLabels[getCurrentLanguage()].close;
    if (!visible || !model) return null;
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.overlay}>
            <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={closeLabel} onPress={onClose} />
            <View testID="codelync-native-model-catalog" style={styles.sheet}>
                <View style={styles.header}><Text style={styles.title}>{t('agentInput.model.title')}</Text>
                    <Pressable testID="codelync-native-model-catalog-close" accessibilityRole="button" accessibilityLabel={closeLabel} onPress={onClose} style={styles.close}>
                        <Text style={styles.link}>{closeLabel}</Text></Pressable></View>
                <ScrollView>{model.models.map(option => <Pressable key={option.id} testID={'codelync-native-model-catalog:' + option.id}
                    accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ disabled: true }} disabled style={styles.row}>
                    <Text style={styles.text}>{option.label}</Text></Pressable>)}</ScrollView>
                <Text style={styles.readonly}>{t('agentInput.codexPermissionMode.readOnly')}</Text>
            </View>
        </View>
    </Modal>;
}
const styles = StyleSheet.create(theme => ({
    overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 }, backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
    sheet: { maxHeight: '70%', borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface },
    header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: 14 }, title: { flex: 1, color: theme.colors.text, ...Typography.default('semiBold') },
    close: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, justifyContent: 'center' }, link: { color: theme.colors.textLink },
    row: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    text: { color: theme.colors.text }, readonly: { color: theme.colors.textSecondary, paddingHorizontal: 14, paddingVertical: 10 },
}));
