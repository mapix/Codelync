import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { TokenStorage } from '@/auth/tokenStorage';
import { config } from '@/config';
import { getServerUrl } from './serverConfig';
import { codelyncAccountScope, loadCodelyncBackgroundCache, saveCodelyncBackgroundCache } from './codelyncBackgroundCache';
import { refreshCodelyncBackground } from './codelyncBackgroundCore';

export const CODELYNC_BACKGROUND_TASK = 'codelync-session-refresh-v2';
TaskManager.defineTask(CODELYNC_BACKGROUND_TASK, async () => {
    const credentials = await TokenStorage.getCredentials();
    if (!config.noninvasiveLocal || !credentials) return BackgroundTask.BackgroundTaskResult.Success;
    const scope = await codelyncAccountScope(credentials);
    const abort = new AbortController(); const deadline = setTimeout(() => abort.abort(), 25000);
    try {
        await refreshCodelyncBackground({ origin: credentials.serverUrl ?? getServerUrl(), token: credentials.token, scope,
            cache: loadCodelyncBackgroundCache(scope), signal: abort.signal,
            stillCurrent: async () => {
                const current = await TokenStorage.getCredentials();
                return !!current && await codelyncAccountScope(current) === scope;
            }, commit: saveCodelyncBackgroundCache });
        return BackgroundTask.BackgroundTaskResult.Success;
    } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
    finally { clearTimeout(deadline); }
});
export async function registerCodelyncBackgroundTask() {
    if (!config.noninvasiveLocal || Platform.OS === 'web' || !await TaskManager.isAvailableAsync()) return;
    // 已安装的 v1 保留 15 分钟调度；迁移到 v2 才能实际应用节能预算，不能只改注册时的默认值。
    if (await TaskManager.isTaskRegisteredAsync('codelync-session-refresh-v1')) await BackgroundTask.unregisterTaskAsync('codelync-session-refresh-v1');
    if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Available
        && !await TaskManager.isTaskRegisteredAsync(CODELYNC_BACKGROUND_TASK)) {
        await BackgroundTask.registerTaskAsync(CODELYNC_BACKGROUND_TASK, { minimumInterval: 60 });
    }
}
