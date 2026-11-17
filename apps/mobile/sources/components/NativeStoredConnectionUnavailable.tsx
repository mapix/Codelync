import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getCurrentLanguage, t } from '@/text';
import type { SupportedLanguage } from '@/text/_all';
const labels: Record<SupportedLanguage, { title: string; reading: string; error: string }> = {
    en: { title: "Connection could not be restored", reading: 'Reading the saved connection…', error: "Unlock your phone, then retry restoring the saved connection." },
    'zh-Hans': { title: "无法恢复连接", reading: '正在读取已保存连接…', error: "请解锁手机，再重试恢复已保存的连接。" },
    'zh-Hant': { title: "無法還原連線", reading: '正在讀取已儲存連線…', error: "請解鎖手機，再重試還原已儲存的連線。" },
    ja: { title: "接続を復元できませんでした", reading: '保存済み接続を読み込み中…', error: "スマートフォンのロックを解除して、保存済み接続の復元を再試行してください。" },
    ru: { title: "Не удалось восстановить подключение", reading: 'Чтение сохранённого подключения…', error: "Разблокируйте телефон и повторите восстановление сохранённого подключения." },
    pl: { title: "Nie można przywrócić połączenia", reading: 'Odczytywanie zapisanego połączenia…', error: "Odblokuj telefon i spróbuj ponownie przywrócić zapisane połączenie." },
    es: { title: "No se pudo restaurar la conexión", reading: 'Leyendo la conexión guardada…', error: "Desbloquea el teléfono y vuelve a restaurar la conexión guardada." },
    it: { title: "Impossibile ripristinare la connessione", reading: 'Lettura della connessione salvata…', error: "Sblocca il telefono e riprova a ripristinare la connessione salvata." },
    pt: { title: "Não foi possível restaurar a conexão", reading: 'Lendo a conexão salva…', error: "Desbloqueie o telefone e tente restaurar a conexão salva novamente." },
    ca: { title: "No s’ha pogut restaurar la connexió", reading: 'Llegint la connexió desada…', error: "Desbloqueja el telèfon i torna a restaurar la connexió desada." },
};
export function NativeStoredConnectionUnavailable({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
    const { theme } = useUnistyles(), copy = labels[getCurrentLanguage()];
    return <View testID="codelync-stored-connection-unavailable" style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 14, backgroundColor: theme.colors.groupped.background }}>
        <Text style={{ color: theme.colors.text, fontSize: 20 }}>{copy.title}</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{busy ? copy.reading : copy.error}</Text>
        {busy ? <ActivityIndicator color={theme.colors.textSecondary} /> : null}
        <Pressable testID="codelync-stored-connection-retry" accessibilityRole="button" disabled={busy} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => { if (!busy) onRetry(); }}><Text style={{ color: theme.colors.text }}>{t('common.retry')}</Text></Pressable>
    </View>;
}
