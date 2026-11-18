import * as TextModule from './index';
import type { SupportedLanguage } from './_all';

export interface CodelyncAgentInputLabels {
    sandboxed: (label: string) => string;
    addPhoto: string;
    send: string;
    stop: string;
    voice: string;
    abort: string;
    changeAgent: string;
    switchMachine: string;
    switchDirectory: string;
    toggleContextDetails: string;
}

export const codelyncAgentInputLabels: Record<SupportedLanguage, CodelyncAgentInputLabels> = {
    en: {
        sandboxed: (label) => `${label} (sandboxed)`,
        addPhoto: 'Add photo',
        send: 'Send',
        stop: 'Stop',
        voice: 'Voice',
        abort: 'Stop response',
        changeAgent: 'Switch agent',
        switchMachine: 'Switch Mac',
        switchDirectory: 'Change directory',
        toggleContextDetails: 'Toggle context usage details',
    },
    'zh-Hans': {
        sandboxed: (label) => `${label}（沙盒）`,
        addPhoto: '添加图片',
        send: '发送',
        stop: '停止',
        voice: '语音',
        abort: '停止回复',
        changeAgent: '切换代理',
        switchMachine: '切换 Mac',
        switchDirectory: '更改目录',
        toggleContextDetails: '切换上下文用量详情',
    },
    'zh-Hant': {
        sandboxed: (label) => `${label}（沙盒）`,
        addPhoto: '新增圖片',
        send: '傳送',
        stop: '停止',
        voice: '語音',
        abort: '停止回覆',
        changeAgent: '切換代理',
        switchMachine: '切換 Mac',
        switchDirectory: '變更目錄',
        toggleContextDetails: '切換上下文用量詳情',
    },
    ja: {
        sandboxed: (label) => `${label}（サンドボックス）`,
        addPhoto: '写真を追加',
        send: '送信',
        stop: '停止',
        voice: '音声',
        abort: '応答を停止',
        changeAgent: 'エージェントを切り替え',
        switchMachine: 'Mac を切り替え',
        switchDirectory: 'ディレクトリを変更',
        toggleContextDetails: 'コンテキスト使用量の詳細を切り替え',
    },
    ru: {
        sandboxed: (label) => `${label} (в песочнице)`,
        addPhoto: 'Добавить фото',
        send: 'Отправить',
        stop: 'Остановить',
        voice: 'Голос',
        abort: 'Остановить ответ',
        changeAgent: 'Сменить агент',
        switchMachine: 'Выбрать Mac',
        switchDirectory: 'Сменить каталог',
        toggleContextDetails: 'Переключить детали контекста',
    },
    pl: {
        sandboxed: (label) => `${label} (piaskownica)`,
        addPhoto: 'Dodaj zdjęcie',
        send: 'Wyślij',
        stop: 'Zatrzymaj',
        voice: 'Głos',
        abort: 'Zatrzymaj odpowiedź',
        changeAgent: 'Zmień agenta',
        switchMachine: 'Zmień Mac',
        switchDirectory: 'Zmień katalog',
        toggleContextDetails: 'Przełącz szczegóły kontekstu',
    },
    es: {
        sandboxed: (label) => `${label} (sandbox)`,
        addPhoto: 'Añadir foto',
        send: 'Enviar',
        stop: 'Detener',
        voice: 'Voz',
        abort: 'Detener respuesta',
        changeAgent: 'Cambiar agente',
        switchMachine: 'Cambiar Mac',
        switchDirectory: 'Cambiar directorio',
        toggleContextDetails: 'Alternar detalles de contexto',
    },
    it: {
        sandboxed: (label) => `${label} (sandbox)`,
        addPhoto: 'Aggiungi foto',
        send: 'Invia',
        stop: 'Ferma',
        voice: 'Voce',
        abort: 'Ferma risposta',
        changeAgent: 'Cambia agente',
        switchMachine: 'Cambia Mac',
        switchDirectory: 'Cambia cartella',
        toggleContextDetails: 'Mostra o nascondi dettagli contesto',
    },
    pt: {
        sandboxed: (label) => `${label} (sandbox)`,
        addPhoto: 'Adicionar foto',
        send: 'Enviar',
        stop: 'Parar',
        voice: 'Voz',
        abort: 'Parar resposta',
        changeAgent: 'Alternar agente',
        switchMachine: 'Alternar Mac',
        switchDirectory: 'Alterar diretório',
        toggleContextDetails: 'Alternar detalhes de contexto',
    },
    ca: {
        sandboxed: (label) => `${label} (sandbox)`,
        addPhoto: 'Afegeix una foto',
        send: 'Envia',
        stop: 'Atura',
        voice: 'Veu',
        abort: 'Atura la resposta',
        changeAgent: 'Canvia d’agent',
        switchMachine: 'Canvia de Mac',
        switchDirectory: 'Canvia de directori',
        toggleContextDetails: 'Commuta els detalls de context',
    },
};

export function agentInputLabelsFor(language: SupportedLanguage): CodelyncAgentInputLabels {
    return codelyncAgentInputLabels[language] ?? codelyncAgentInputLabels.en;
}

export function getAgentInputLabels(): CodelyncAgentInputLabels {
    const language = typeof TextModule.getCurrentLanguage === 'function'
        ? TextModule.getCurrentLanguage()
        : 'en';
    return agentInputLabelsFor(language);
}
