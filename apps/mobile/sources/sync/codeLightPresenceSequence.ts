type SequenceStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

/** Device-local ordering survives app reloads; keys contain only peer/origin scope. */
export class CodeLightPresenceSequence {
    private latest = new Map<string, Promise<number>>();
    constructor(private readonly storage: SequenceStorage) {}
    next(scope: string): Promise<number> {
        const key = 'codelight-presence-sequence-v1:' + scope;
        const previous = this.latest.get(scope) ?? this.storage.getItem(key).then(value => {
            const sequence = value === null ? 0 : Number(value);
            if (!Number.isSafeInteger(sequence) || sequence < 0) throw Error('Invalid foreground sequence');
            return sequence;
        });
        const next = previous.then(async sequence => {
            if (sequence >= Number.MAX_SAFE_INTEGER) throw Error('Foreground sequence exhausted');
            const value = sequence + 1; await this.storage.setItem(key, String(value)); return value;
        });
        this.latest.set(scope, next);
        void next.catch(() => { if (this.latest.get(scope) === next) this.latest.delete(scope); });
        return next;
    }
}
