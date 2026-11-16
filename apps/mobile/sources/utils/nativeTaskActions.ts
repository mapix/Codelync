import type { Session } from '@/sync/storageTypes';
import type { NativeTasks, NativeTaskScope } from '@/sync/nativeTasks';
import { captureCurrentNativeTaskScope, nativeTaskScopesEqual, projectCodeLightNativeTasks } from './codeLightNativeTasks';
import { nativeComposerInputReadOnly } from './nativeComposerInputReadOnly';

export type NativeTaskAction = 'output' | 'stop';
export type NativeTaskActionView = { session: Session | undefined; native: NativeTasks | null; active: boolean };

/** Per-type capabilities do not imply parent cancellation or controls for another query. */
export function nativeTaskActionAllowed(view: NativeTaskActionView, scope: NativeTaskScope, taskId: string, action: NativeTaskAction): boolean {
    const { session, native, active } = view, current = captureCurrentNativeTaskScope(session), capabilities = session?.metadata?.capabilities;
    if (!active || !session || !capabilities || !current || !nativeTaskScopesEqual(current, scope)
        || action === 'stop' && (capabilities.readOnly !== false || nativeComposerInputReadOnly(session))) return false;
    const projected = projectCodeLightNativeTasks(session, native), controls = capabilities.nativeTaskControls;
    const row = projected.available ? projected.rows.find(row => row.nativeTaskId === taskId) : undefined;
    const method = action === 'output' ? 'native-task-output-read' : 'native-task-stop';
    const types = action === 'output' ? controls?.outputTaskTypes : controls?.stopTaskTypes;
    return !!row && row.kind !== 'other' && controls?.version === 1 && Array.isArray(types) && types.includes(row.taskType)
        && capabilities.rpcMethods.includes(method)
        && (action === 'output' || ['pending', 'running', 'paused'].includes(row.status));
}

export function createNativeTaskActions(options: {
    authority(): string;
    current(id: string): NativeTaskActionView;
    output(id: string, scope: NativeTaskScope, taskId: string): Promise<unknown>;
    journal(id: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}) {
    const pending = new Map<string, Promise<unknown>>();
    const check = (id: string, scope: NativeTaskScope, taskId: string, action: NativeTaskAction, authority: string) => {
        if (authority !== options.authority() || !nativeTaskActionAllowed(options.current(id), scope, taskId, action)) throw Error('Native task action unavailable');
    };
    return {
        async output(id: string, scope: NativeTaskScope, taskId: string) {
            const authority = options.authority(); check(id, scope, taskId, 'output', authority);
            const value = await options.output(id, scope, taskId);
            check(id, scope, taskId, 'output', authority); return value;
        },
        stop(id: string, scope: NativeTaskScope, taskId: string) {
            const authority = options.authority(), key = JSON.stringify([authority, id, scope, taskId]);
            check(id, scope, taskId, 'stop', authority);
            if (pending.has(key)) return pending.get(key)!;
            // The existing journal creates/persists the command ID and recovers only its receipt.
            const operation = Promise.resolve().then(() => {
                check(id, scope, taskId, 'stop', authority);
                return options.journal(id, 'native-task-stop', { scope: { ...scope }, taskId });
            }).finally(() => { if (pending.get(key) === operation) pending.delete(key); });
            pending.set(key, operation); return operation;
        },
    };
}
