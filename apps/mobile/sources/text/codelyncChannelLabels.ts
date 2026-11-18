import type { SupportedLanguage } from './_all';

export interface CodelyncChannelLabels {
    desired: string;
    current: string;
    failed: string;
    unsaved: string;
    locate: string;
}

export const codelyncChannelLabels: Record<SupportedLanguage, CodelyncChannelLabels> = {
    en: {
        desired: 'Selected',
        current: 'Current connection',
        failed: 'Choice saved. It is not connected yet.',
        unsaved: 'The choice was not saved. Try again.',
        locate: 'If saved addresses are unavailable, scan the current code on the same Mac or update its location over USB.',
    },
    'zh-Hans': {
        desired: '希望使用',
        current: '当前连接',
        failed: '已保存所选方式，当前未接通。',
        unsaved: '选择尚未保存，请重试。',
        locate: '当前地址不可用时，请扫描同一台 Mac 的当前二维码，或通过 USB 更新其位置。',
    },
    'zh-Hant': {
        desired: '希望使用',
        current: '目前連線',
        failed: '已儲存所選方式，目前尚未連線。',
        unsaved: '選擇尚未儲存，請重試。',
        locate: '目前位址無法使用時，請掃描同一台 Mac 的目前 QR Code，或透過 USB 更新其位置。',
    },
    ja: {
        desired: '選択した経路',
        current: '現在の接続',
        failed: '選択を保存しました。まだ接続されていません。',
        unsaved: '選択を保存できませんでした。再試行してください。',
        locate: '保存済みのアドレスに接続できない場合は、同じ Mac に表示されている QR コードを読み取るか、USB 経由で接続先を更新してください。',
    },
    ru: {
        desired: 'Выбрано',
        current: 'Текущее подключение',
        failed: 'Выбор сохранён, но подключение пока не установлено.',
        unsaved: 'Выбор не сохранён. Повторите попытку.',
        locate: 'Если сохранённые адреса недоступны, отсканируйте текущий QR-код на том же Mac или обновите адрес по USB.',
    },
    pl: {
        desired: 'Wybrano',
        current: 'Bieżące połączenie',
        failed: 'Wybór zapisano, ale połączenie nie jest jeszcze aktywne.',
        unsaved: 'Wybór nie został zapisany. Spróbuj ponownie.',
        locate: 'Jeśli zapisane adresy są niedostępne, zeskanuj bieżący kod na tym samym Macu lub zaktualizuj adres przez USB.',
    },
    es: {
        desired: 'Seleccionado',
        current: 'Conexión actual',
        failed: 'Selección guardada. Aún no está conectada.',
        unsaved: 'No se guardó la selección. Inténtalo de nuevo.',
        locate: 'Si las direcciones guardadas no están disponibles, escanea el código actual en el mismo Mac o actualiza su ubicación por USB.',
    },
    it: {
        desired: 'Selezionato',
        current: 'Connessione attuale',
        failed: 'Scelta salvata. Non è ancora connessa.',
        unsaved: 'La scelta non è stata salvata. Riprova.',
        locate: 'Se gli indirizzi salvati non sono disponibili, scansiona il codice attuale sullo stesso Mac o aggiorna la posizione tramite USB.',
    },
    pt: {
        desired: 'Selecionado',
        current: 'Conexão atual',
        failed: 'Escolha salva. Ainda não está conectada.',
        unsaved: 'A escolha não foi salva. Tente novamente.',
        locate: 'Se os endereços salvos não estiverem disponíveis, escaneie o código atual no mesmo Mac ou atualize a localização por USB.',
    },
    ca: {
        desired: 'Seleccionat',
        current: 'Connexió actual',
        failed: 'Elecció desada. Encara no està connectada.',
        unsaved: 'L’elecció no s’ha desat. Torna-ho a provar.',
        locate: 'Si les adreces desades no estan disponibles, escaneja el codi actual al mateix Mac o actualitza la seva ubicació per USB.',
    },
};
