import type { SupportedLanguage } from './_all';
export const nativeParentControlLabels: Record<SupportedLanguage, { managed: string; continue: string; unavailable: string }> = {
    en: { managed: 'Input is managed by the parent session.', continue: 'Continue in parent', unavailable: "Parent session unavailable. Refresh sessions to find it." },
    'zh-Hans': { managed: '输入由父会话管理。', continue: '在父会话中继续', unavailable: "父会话当前不可用，请刷新会话列表。" },
    'zh-Hant': { managed: '輸入由父會話管理。', continue: '在父會話中繼續', unavailable: "父會話目前無法取得，請重新整理會話列表。" },
    ja: { managed: '入力は親の会話が管理します。', continue: '親の会話で続ける', unavailable: "親のセッションが利用できません。セッション一覧を更新してください。" },
    ru: { managed: 'Ввод управляется родительским чатом.', continue: 'Продолжить в родительском чате', unavailable: "Родительский сеанс недоступен. Обновите список сеансов." },
    pl: { managed: 'Wprowadzaniem zarządza czat nadrzędny.', continue: 'Kontynuuj w czacie nadrzędnym', unavailable: "Sesja nadrzędna jest niedostępna. Odśwież listę sesji." },
    es: { managed: 'La conversación principal gestiona la entrada.', continue: 'Continuar en la conversación principal', unavailable: "La sesión principal no está disponible. Actualiza la lista de sesiones." },
    it: { managed: 'La chat principale gestisce l’input.', continue: 'Continua nella chat principale', unavailable: "La sessione principale non è disponibile. Aggiorna l’elenco delle sessioni." },
    pt: { managed: 'A conversa principal gerencia a entrada.', continue: 'Continuar na conversa principal', unavailable: "A sessão principal está indisponível. Atualize a lista de sessões." },
    ca: { managed: 'La conversa principal gestiona l’entrada.', continue: 'Continua a la conversa principal', unavailable: "La sessió principal no està disponible. Actualitza la llista de sessions." },
};
