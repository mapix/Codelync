import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV({ id: 'codelync-app-state-v1' });

const LAST_VIEWED_KEY = 'codelync-changelog-last-viewed-title';

export function getLastViewedTitle(): string {
    return mmkv.getString(LAST_VIEWED_KEY) ?? '';
}

export function setLastViewedTitle(title: string): void {
    mmkv.set(LAST_VIEWED_KEY, title);
}

export function hasUnreadChangelog(latestTitle: string): boolean {
    return latestTitle !== '' && latestTitle !== getLastViewedTitle();
}
