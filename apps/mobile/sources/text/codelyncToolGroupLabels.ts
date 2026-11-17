import type { SupportedLanguage } from './_all';

export const codelyncToolGroupLabels: Record<SupportedLanguage, (count: number) => string> = {
    en: count => `${count} tool ${count === 1 ? 'call' : 'calls'}`,
    'zh-Hans': count => `${count} 个工具调用`,
    'zh-Hant': count => `${count} 個工具呼叫`,
    ja: count => `${count} 件のツール呼び出し`,
    ru: count => `Вызовы инструментов: ${count}`,
    pl: count => `Wywołania narzędzi: ${count}`,
    es: count => `${count} llamadas a herramientas`,
    it: count => `${count} chiamate a strumenti`,
    pt: count => `${count} chamadas de ferramentas`,
    ca: count => `${count} crides d'eines`,
};

const locales: Record<SupportedLanguage, string> = {
    en: 'en', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', ja: 'ja', ru: 'ru',
    pl: 'pl', es: 'es', it: 'it', pt: 'pt', ca: 'ca',
};

export function formatToolGroupTimestamp(timestamp: number | null, language: SupportedLanguage): string {
    if (timestamp === null || !Number.isFinite(timestamp) || timestamp < 0 || !Number.isFinite(new Date(timestamp).getTime())) return '—';
    return new Intl.DateTimeFormat(locales[language], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
