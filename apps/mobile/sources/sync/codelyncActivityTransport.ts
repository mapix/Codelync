import { parseActivityReply, sameActivityGroupFields, type ActivityReply, type CodelyncActivityRequest } from './codelyncProjectActivity';

type Options = {
    peerIdentity(): string | null;
    endpoint(): string;
    request(body: Record<string, unknown>): Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
};
type Baseline = { fingerprint: string; interestToken: string; watermark: string; epoch: string; sequence: number; groups: ActivityReply['groups'] };
type FingerprintEntry = { groups: CodelyncActivityRequest['groups']; fingerprint: string };
type ActivityV2 = { ok: true; version: 2; machineId: string; epoch: string; sequence: number; observedAt: number;
    interestToken: string | null; mode: 'full' | 'delta' | 'unchanged'; watermark: string; baseWatermark: string | null;
    groups: ActivityReply['groups']; removedIds: string[] };
const identity = (value: unknown, max = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function sameActivityGroupList(a: CodelyncActivityRequest['groups'], b: CodelyncActivityRequest['groups']): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (!sameActivityGroupFields(a[i], b[i])) return false;
    }
    return true;
}

function cloneActivityGroups(groups: CodelyncActivityRequest['groups']): CodelyncActivityRequest['groups'] {
    return groups.map(group => ({
        id: group.id,
        projectKey: group.projectKey,
        hostId: group.hostId,
        ...(group.app !== undefined ? { app: group.app } : {}),
        ...(group.sessions !== undefined ? { sessions: group.sessions.map(row => ({ id: row.id, nativeId: row.nativeId })) } : {}),
    }));
}

/** One bounded baseline per activity client/machine. Never owns native input. */
export class CodelyncActivityTransport {
    private baselines = new Map<string, Baseline>();
    private latest = new Map<string, number>();
    private fingerprints = new Map<string, FingerprintEntry>();
    private flights = new Map<string, Promise<ActivityReply>>();
    constructor(private readonly options: Options) {}

    read(machineId: string, params: CodelyncActivityRequest, authority = ''): Promise<ActivityReply> {
        const peer = this.options.peerIdentity();
        if (!peer) return Promise.reject(Error('An authenticated Mac is required for HTTP activity'));
        const key = JSON.stringify([authority, peer, machineId, params.clientId]);
        const fingerprint = this.resolveFingerprint(key, params.groups);
        const flightKey = `${key}\n${params.requestSeq}\n${fingerprint}`;
        const pending = this.flights.get(flightKey); if (pending) return pending;
        const previousSeq = this.latest.get(key);
        if (previousSeq !== undefined) this.latest.delete(key);
        else if (this.latest.size >= 32) this.latest.delete(this.latest.keys().next().value!);
        this.latest.set(key, Math.max(previousSeq ?? -1, params.requestSeq));
        const run = this.perform(key, peer, machineId, params, fingerprint).finally(() => { if (this.flights.get(flightKey) === run) this.flights.delete(flightKey); });
        this.flights.set(flightKey, run); return run;
    }

    private resolveFingerprint(key: string, groups: CodelyncActivityRequest['groups']): string {
        if (!groups.length) return '[]';
        const cached = this.fingerprints.get(key);
        if (cached && sameActivityGroupList(cached.groups, groups)) {
            this.fingerprints.delete(key);
            this.fingerprints.set(key, cached);
            return cached.fingerprint;
        }
        const fingerprint = JSON.stringify(groups);
        if (cached) this.fingerprints.delete(key);
        else if (this.fingerprints.size >= 32) this.fingerprints.delete(this.fingerprints.keys().next().value!);
        this.fingerprints.set(key, { groups: cloneActivityGroups(groups), fingerprint });
        return fingerprint;
    }

    private async perform(key: string, peer: string, machine: string, params: CodelyncActivityRequest, fingerprint: string): Promise<ActivityReply> {
        const previous = this.baselines.get(key);
        let baseline = previous?.fingerprint === fingerprint && params.groups.length ? previous : undefined;
        if (!params.groups.length) this.baselines.delete(key);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (this.options.peerIdentity() !== peer) throw Error('Activity peer changed');
            const body = { activityProtocol: 2, clientId: params.clientId, requestSeq: params.requestSeq,
                ...(baseline ? { interestToken: baseline.interestToken, since: baseline.watermark } : { groups: params.groups }) };
            const endpoint = this.options.endpoint();
            let response: Pick<Response, 'ok' | 'status' | 'json'>;
            try { response = await this.options.request(body); }
            catch (error) {
                if (attempt === 0 && this.options.peerIdentity() === peer && this.options.endpoint() !== endpoint) continue;
                throw error;
            }
            if (this.options.peerIdentity() !== peer) throw Error('Activity peer changed');
            if (!response.ok) {
                if (response.status === 409 && baseline && attempt === 0) { this.baselines.delete(key); baseline = undefined; continue; }
                throw Error(`Project activity unavailable: ${response.status}`);
            }
            const raw = await response.json();
            if (this.options.peerIdentity() !== peer) throw Error('Activity peer changed');
            if ((raw as { version?: unknown } | null)?.version === 1) {
                if ((raw as { machineId?: unknown }).machineId !== undefined && (raw as { machineId: unknown }).machineId !== machine) throw Error('Activity machine changed');
                this.baselines.delete(key); return parseActivityReply(raw);
            }
            const value = raw as ActivityV2;
            if (!value || value.ok !== true || value.version !== 2 || value.machineId !== machine || !identity(value.epoch, 512)
                || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0
                || !identity(value.watermark) || value.baseWatermark !== null && !identity(value.baseWatermark)
                || value.interestToken !== null && !identity(value.interestToken, 4096)
                || !['full', 'delta', 'unchanged'].includes(value.mode) || !Array.isArray(value.removedIds)
                || value.removedIds.length > 16 || !value.removedIds.every(id => identity(id, 8192)) || new Set(value.removedIds).size !== value.removedIds.length) throw Error('Invalid HTTP activity reply');
            const parsed = parseActivityReply({ ...value, version: 1 });
            const wanted = new Set(params.groups.map(group => group.id));
            if (parsed.groups.some(group => !wanted.has(group.id)) || value.removedIds.some(id => !wanted.has(id))) throw Error('Activity interest changed');
            if (value.mode !== 'full' && (!baseline || value.epoch !== baseline.epoch || value.baseWatermark !== baseline.watermark
                || value.sequence < baseline.sequence)) throw Error('Activity delta baseline changed');
            if (value.mode === 'unchanged' && (parsed.groups.length || value.removedIds.length)) throw Error('An unchanged activity reply carried changes');
            const groups = value.mode === 'full' ? new Map<string, ActivityReply['groups'][number]>() : new Map(baseline!.groups.map(group => [group.id, group]));
            for (const id of value.removedIds) groups.delete(id);
            for (const group of parsed.groups) groups.set(group.id, group);
            const fullGroups = [...groups.values()];
            const result = parseActivityReply({ ...parsed, groups: fullGroups, ...(value.mode === 'unchanged' ? { unchanged: true } : {}) });
            if (this.latest.get(key) === params.requestSeq && this.options.peerIdentity() === peer) {
                if (params.groups.length && value.interestToken) {
                    if (this.baselines.has(key)) this.baselines.delete(key);
                    else if (this.baselines.size >= 16) this.baselines.delete(this.baselines.keys().next().value!);
                    this.baselines.set(key, { fingerprint, interestToken: value.interestToken, watermark: value.watermark,
                        epoch: value.epoch, sequence: value.sequence, groups: fullGroups });
                } else this.baselines.delete(key);
            }
            return result;
        }
        throw Error('Project activity could not restore its interest');
    }
}
