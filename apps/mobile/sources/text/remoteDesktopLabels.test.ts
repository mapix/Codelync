import { describe, expect, it, vi } from 'vitest';
vi.mock('./index', () => ({ getCurrentLanguage: () => 'ja' }));
import { remoteDesktopLabels, remoteDesktopLabelsFor, remoteDesktopError } from './remoteDesktopLabels';

describe('Japanese remote desktop', () => {
    it('covers every control and retains explicit unconfirmed and permission states', () => {
        const english = remoteDesktopLabelsFor('en'), japanese = remoteDesktopLabels();
        expect(Object.keys(japanese).sort()).toEqual(Object.keys(english).sort());
        expect(Object.values(japanese).every(value => value.length > 0)).toBe(true);
        expect(japanese.connect).toBe('接続');
        expect(remoteDesktopError('desktop-operation-unknown')).toContain('未確認');
        expect(remoteDesktopError('desktop-screen-permission-required')).toContain('画面収録');
        expect(remoteDesktopLabelsFor('zh-Hans').connect).toBe('连接');
    });
});
