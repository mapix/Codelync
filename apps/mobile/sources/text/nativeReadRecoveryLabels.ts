import type { SupportedLanguage } from './_all';
export const nativeReadRecoveryLabels: Record<SupportedLanguage, { checking: string; failed: string }> = {
    en: { checking: 'Checking current state…', failed: 'Refresh failed. Your saved messages are still here.' },
    'zh-Hans': { checking: '正在确认当前状态…', failed: '刷新失败，已保存的消息仍在。' },
    'zh-Hant': { checking: '正在確認目前狀態…', failed: '重新整理失敗，已儲存的訊息仍在。' },
    ja: { checking: '現在の状態を確認中…', failed: '更新できませんでした。保存済みメッセージは残っています。' },
    ru: { checking: 'Проверка текущего состояния…', failed: 'Не удалось обновить. Сохранённые сообщения остаются.' },
    pl: { checking: 'Sprawdzanie bieżącego stanu…', failed: 'Odświeżanie nie powiodło się. Zapisane wiadomości pozostają.' },
    es: { checking: 'Comprobando el estado actual…', failed: 'No se pudo actualizar. Tus mensajes guardados siguen aquí.' },
    it: { checking: 'Verifica dello stato attuale…', failed: 'Aggiornamento non riuscito. I messaggi salvati sono ancora qui.' },
    pt: { checking: 'Verificando o estado atual…', failed: 'A atualização falhou. Suas mensagens salvas continuam aqui.' },
    ca: { checking: 'Comprovant l’estat actual…', failed: 'No s’ha pogut actualitzar. Els missatges desats continuen aquí.' },
};
