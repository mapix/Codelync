import { useMemo } from 'react';
import type { Session } from '@/sync/storageTypes';
import { projectCodeLightSubagents } from '@/utils/codeLightSubagents';
import { useCodeLightNativeTaskData } from './useCodeLightNativeTaskData';
const EMPTY_CATALOG: Session[] = [];

/** No child histories. Claude row reads require an expanded foreground intent. */
export function useCodeLightSubagents(session: Session | null, catalog: Session[] = EMPTY_CATALOG, expanded = false, active = true) {
    const data = useCodeLightNativeTaskData(session, expanded, active);
    const view = useMemo(() => projectCodeLightSubagents(session, catalog, undefined, session?.metadata?.bridge?.source.app === 'claude-desktop' ? data.native : undefined), [session, catalog, data.native]);
    return { ...view, loading: data.loading, failed: data.failed, retry: data.retry };
}
