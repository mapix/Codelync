import type { SupportedLanguage } from './_all';
import type { NativeSubagentStatus } from '../sync/nativeSubagents';

type Labels = { title: string; empty: string; unavailable: string; partial: string; status: Record<NativeSubagentStatus, string> };

/** Kept separate from concurrent model/command copy changes; all product languages are explicit. */
export const codelyncSubagentLabels: Record<SupportedLanguage, Labels> = {
    en: { title: 'Subagents', empty: "No subagents in this session.", unavailable: "Subagent status could not be confirmed. Try again.", partial: 'Partial list',
        status: { pending: 'Pending', running: 'Running', waiting: 'Awaiting action', idle: 'Idle', stopped: 'Stopped', completed: 'Completed', failed: 'Failed', unknown: 'Unconfirmed' } },
    'zh-Hans': { title: '子代理', empty: "这个会话没有子代理。", unavailable: "无法确认子代理状态，请重试。", partial: '部分列表',
        status: { pending: '待开始', running: '运行中', waiting: '待操作', idle: '空闲', stopped: '已停止', completed: '已完成', failed: '失败', unknown: '未确认' } },
    'zh-Hant': { title: '子代理', empty: "這個會話沒有子代理。", unavailable: "無法確認子代理狀態，請重試。", partial: '部分清單',
        status: { pending: '待開始', running: '執行中', waiting: '待操作', idle: '空閒', stopped: '已停止', completed: '已完成', failed: '失敗', unknown: '未確認' } },
    ja: { title: 'サブエージェント', empty: "このセッションにサブエージェントはいません。", unavailable: "サブエージェントの状態を確認できませんでした。再試行してください。", partial: '一部の一覧',
        status: { pending: '開始待ち', running: '実行中', waiting: '操作待ち', idle: '待機中', stopped: '停止', completed: '完了', failed: '失敗', unknown: '未確認' } },
    ru: { title: 'Субагенты', empty: "В этом сеансе нет субагентов.", unavailable: "Не удалось подтвердить статус субагентов. Повторите попытку.", partial: 'Неполный список',
        status: { pending: 'Ожидает запуска', running: 'Выполняется', waiting: 'Ожидает действия', idle: 'Бездействует', stopped: 'Остановлен', completed: 'Завершён', failed: 'Ошибка', unknown: 'Не подтверждено' } },
    pl: { title: 'Podagenci', empty: "W tej sesji nie ma podagentów.", unavailable: "Nie można potwierdzić statusu podagentów. Spróbuj ponownie.", partial: 'Lista częściowa',
        status: { pending: 'Oczekuje', running: 'W toku', waiting: 'Oczekuje na działanie', idle: 'Bezczynny', stopped: 'Zatrzymany', completed: 'Ukończony', failed: 'Błąd', unknown: 'Niepotwierdzony' } },
    es: { title: 'Subagentes', empty: "No hay subagentes en esta sesión.", unavailable: "No se pudo confirmar el estado de los subagentes. Vuelve a intentarlo.", partial: 'Lista parcial',
        status: { pending: 'Pendiente', running: 'En ejecución', waiting: 'Esperando acción', idle: 'Inactivo', stopped: 'Detenido', completed: 'Completado', failed: 'Error', unknown: 'Sin confirmar' } },
    it: { title: 'Subagenti', empty: "Nessun subagente in questa sessione.", unavailable: "Impossibile confermare lo stato dei subagenti. Riprova.", partial: 'Elenco parziale',
        status: { pending: 'In attesa', running: 'In esecuzione', waiting: 'In attesa di azione', idle: 'Inattivo', stopped: 'Interrotto', completed: 'Completato', failed: 'Errore', unknown: 'Non confermato' } },
    pt: { title: 'Subagentes', empty: "Não há subagentes nesta sessão.", unavailable: "Não foi possível confirmar o status dos subagentes. Tente novamente.", partial: 'Lista parcial',
        status: { pending: 'Pendente', running: 'Em execução', waiting: 'Aguardando ação', idle: 'Ocioso', stopped: 'Parado', completed: 'Concluído', failed: 'Falhou', unknown: 'Não confirmado' } },
    ca: { title: 'Subagents', empty: "No hi ha subagents en aquesta sessió.", unavailable: "No s’ha pogut confirmar l’estat dels subagents. Torna-ho a provar.", partial: 'Llista parcial',
        status: { pending: 'Pendent', running: 'En execució', waiting: 'Esperant acció', idle: 'Inactiu', stopped: 'Aturat', completed: 'Completat', failed: 'Fallat', unknown: 'Sense confirmar' } },
};

type InteractionLabels = { parent: string; noMatches: string; filters: { all: string; 'in-progress': string; finished: string; unknown: string } };
export const codelyncSubagentInteractionLabels: Record<SupportedLanguage, InteractionLabels> = {
    en: { parent: 'Parent', noMatches: 'No matching subagents.', filters: { all: 'All', 'in-progress': 'In progress', finished: 'Finished', unknown: 'Unconfirmed' } },
    'zh-Hans': { parent: '父会话', noMatches: '没有符合筛选的子代理。', filters: { all: '全部', 'in-progress': '进行中', finished: '已结束', unknown: '未确认' } },
    'zh-Hant': { parent: '父會話', noMatches: '沒有符合篩選的子代理。', filters: { all: '全部', 'in-progress': '進行中', finished: '已結束', unknown: '未確認' } },
    ja: { parent: '親の会話', noMatches: '一致するサブエージェントはありません。', filters: { all: 'すべて', 'in-progress': '進行中', finished: '終了', unknown: '未確認' } },
    ru: { parent: 'Родительский чат', noMatches: 'Подходящих субагентов нет.', filters: { all: 'Все', 'in-progress': 'В работе', finished: 'Завершены', unknown: 'Не подтверждено' } },
    pl: { parent: 'Czat nadrzędny', noMatches: 'Brak pasujących podagentów.', filters: { all: 'Wszystkie', 'in-progress': 'W toku', finished: 'Zakończone', unknown: 'Niepotwierdzone' } },
    es: { parent: 'Conversación principal', noMatches: 'No hay subagentes coincidentes.', filters: { all: 'Todos', 'in-progress': 'En curso', finished: 'Finalizados', unknown: 'Sin confirmar' } },
    it: { parent: 'Chat principale', noMatches: 'Nessun subagente corrispondente.', filters: { all: 'Tutti', 'in-progress': 'In corso', finished: 'Terminati', unknown: 'Non confermati' } },
    pt: { parent: 'Conversa principal', noMatches: 'Nenhum subagente correspondente.', filters: { all: 'Todos', 'in-progress': 'Em andamento', finished: 'Encerrados', unknown: 'Não confirmados' } },
    ca: { parent: 'Conversa principal', noMatches: 'No hi ha subagents coincidents.', filters: { all: 'Tots', 'in-progress': 'En curs', finished: 'Finalitzats', unknown: 'Sense confirmar' } },
};

export const codelyncSubagentKindLabels: Record<SupportedLanguage, string> = {
    en: 'Subagent', 'zh-Hans': '子代理', 'zh-Hant': '子代理', ja: 'サブエージェント', ru: 'Субагент', pl: 'Podagent',
    es: 'Subagente', it: 'Subagente', pt: 'Subagente', ca: 'Subagent',
};
