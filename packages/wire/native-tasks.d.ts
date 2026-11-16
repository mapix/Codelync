export const NATIVE_TASK_SNAPSHOT_MAX_BYTES: number;
export function nativeTaskScopesEqual(a: unknown, b: unknown): boolean;
export function nativeTaskDispatchKey(row: Record<string, unknown>): string;
export function nativeTaskDigestText(value: Record<string, unknown>): string;
export function nativeTaskSignal(value: Record<string, unknown>): Record<string, any>;
export function nativeTaskTransferApply(base: Record<string, unknown> | null, response: Record<string, unknown>): Record<string, any>;
export function nativeTaskTransfer(base: Record<string, unknown> | null, target: Record<string, unknown>): Record<string, any>;
