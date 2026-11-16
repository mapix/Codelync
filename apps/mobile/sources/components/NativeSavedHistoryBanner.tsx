import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getCurrentLanguage } from '@/text';
import type { SupportedLanguage } from '@/text/_all';
import type { Session } from '@/sync/storageTypes';
import { codeLightSavedHistory } from '@/utils/nativeSavedHistory';
const labels: Record<SupportedLanguage, string> = {
    "en": "Saved messages · Read only",
    "zh-Hans": "已保存消息 · 只读",
    "zh-Hant": "已儲存訊息 · 唯讀",
    "ja": "保存済みメッセージ · 読み取り専用",
    "ru": "Сохранённые сообщения · Только чтение",
    "pl": "Zapisane wiadomości · Tylko odczyt",
    "es": "Mensajes guardados · Solo lectura",
    "it": "Messaggi salvati · Sola lettura",
    "pt": "Mensagens salvas · Somente leitura",
    "ca": "Missatges desats · Només lectura",
};
export function NativeSavedHistoryBanner({ session, topInset = 0 }: { session: Session; topInset?: number }) {
    const { theme } = useUnistyles();
    if (!codeLightSavedHistory(session)) return null;
    return <View testID="codelight-saved-history" style={{ paddingHorizontal: 14, paddingTop: topInset + 14, paddingBottom: 14, backgroundColor: theme.colors.groupped.background }}>
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{labels[getCurrentLanguage()]}</Text>
    </View>;
}
