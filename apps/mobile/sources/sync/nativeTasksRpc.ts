import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { storage } from './storage';
import { NativeTaskLogPageSchema, NativeTaskReadReplySchema, NativeTaskOutputSchema, type NativeTaskScope } from './nativeTasks';
import { captureCurrentNativeTaskScope, nativeTaskScopesEqual } from '@/utils/codelyncNativeTasks';
import type { Session } from './storageTypes';

type Context = { current(id: string): Session | undefined; authority(): string;
    rpc(id: string, method: string, payload: Record<string, unknown>): Promise<unknown> };
const context: Context = { current: id => storage.getState().sessions[id], authority: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (id, method, payload) => apiSocket.sessionRPC(id, method, payload, getServerUrl()) };

/** Read-only peer RPC: no operation journal, command ID, receipt recovery or model call. */
export function createNativeTaskReader(options: Context) {
    async function read(id: string, scope: NativeTaskScope, method: string, extra: Record<string, unknown>) {
        const authority = options.authority();
        const assertCurrent = () => {
            const current = captureCurrentNativeTaskScope(options.current(id));
            if (authority !== options.authority() || !current || !nativeTaskScopesEqual(current, scope)) throw Error('Native task scope changed');
        };
        assertCurrent();
        const response = await options.rpc(id, method, { scope: { ...scope }, ...extra });
        assertCurrent(); return response;
    }
    return {
        async output(id: string, scope: NativeTaskScope, taskId: string) {
            if (!taskId.trim() || taskId.length > 256) throw Error('Invalid native task');
            const parsed = NativeTaskOutputSchema.safeParse(await read(id, scope, 'native-task-output-read', { taskId }));
            if (!parsed.success || parsed.data.taskId !== taskId || !nativeTaskScopesEqual(parsed.data.scope, scope)) throw Error('Native task output unavailable');
            return parsed.data;
        },
        async tasks(id: string, scope: NativeTaskScope, since?: string) {
            if (since !== undefined && !/^[a-f0-9]{64}$/.test(since)) throw Error('Invalid native task baseline digest');
            const parsed = NativeTaskReadReplySchema.safeParse(await read(id, scope, 'native-task-read', since ? { since } : {}));
            if (!parsed.success || !nativeTaskScopesEqual(parsed.data.scope, scope)) throw Error('Native task read unavailable');
            return parsed.data;
        },
        async logs(id: string, scope: NativeTaskScope, params: { taskId?: string | null; before?: string | null; limit?: number } = {}) {
            const taskId = params.taskId ?? null, before = params.before ?? null, limit = params.limit ?? 12;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || taskId !== null && (!taskId.trim() || taskId.length > 256)
                || before !== null && (!before.trim() || before.length > 256)) throw Error('Invalid native task log page');
            const parsed = NativeTaskLogPageSchema.safeParse(await read(id, scope, 'native-task-log-read', { taskId, before, limit }));
            if (!parsed.success || !nativeTaskScopesEqual(parsed.data.scope, scope) || parsed.data.logs.length > limit
                || taskId !== null && parsed.data.logs.some(row => row.nativeTaskId !== taskId)
                || parsed.data.available && (parsed.data.status !== 'ok' || parsed.data.hasMore === null
                    || parsed.data.hasMore && (!parsed.data.nextCursor || parsed.data.nextCursor === before || !parsed.data.logs.length))) throw Error('Native task log read unavailable');
            return parsed.data;
        },
    };
}
export const nativeTaskReader = createNativeTaskReader(context);
