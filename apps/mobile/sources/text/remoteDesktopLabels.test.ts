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

    it('I18N-01 & I18N-02: enforces 4-locale key parity with non-empty localized Phase 1 & Phase 2 copy and zero English fallback on CJK', () => {
        const en = remoteDesktopLabelsFor('en');
        const enKeys = Object.keys(en).sort();
        const phase1And2Keys = [
            'phoneScreen',
            'windows',
            'restoreWindows',
            'windowsLoading',
            'windowsEmpty',
            'untitledWindow',
            'windowOnPhone',
            'windowMinimized',
            'virtualDisplayUnavailable',
            'virtualDisplayRequired',
            'windowUnavailable',
            'windowUnresponsive',
            'restorePersistFailed',
            'displayChanged',
        ] as const;

        for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
            const labels = remoteDesktopLabelsFor(lang);
            expect(Object.keys(labels).sort()).toEqual(enKeys);
            for (const value of Object.values(labels)) {
                expect(value.trim().length).toBeGreaterThan(0);
            }
            if (lang !== 'en') {
                for (const key of phase1And2Keys) {
                    expect(labels[key]).not.toBe(en[key]);
                }
            }
        }

        const zhHans = remoteDesktopLabelsFor('zh-Hans');
        const zhHant = remoteDesktopLabelsFor('zh-Hant');
        expect(zhHant.phoneScreen).not.toBe(zhHans.phoneScreen);
        expect(zhHant.windows).not.toBe(zhHans.windows);
        expect(zhHant.restoreWindows).not.toBe(zhHans.restoreWindows);
    });

    it('I18N-03: maps all Phase 1 and Phase 2 deterministic domain error codes to actionable localized messages', () => {
        const jaLabels = remoteDesktopLabelsFor('ja');
        const codes = [
            'desktop-virtual-display-unavailable',
            'desktop-virtual-display-required',
            'desktop-accessibility-required',
            'desktop-window-unavailable',
            'desktop-window-unresponsive',
            'desktop-restore-persist-failed',
            'desktop-view-changed',
            'desktop-display-changed',
            'desktop-operation-unknown',
        ];
        const messages = codes.map(code => remoteDesktopError(code));
        for (const message of messages) {
            expect(message.trim().length).toBeGreaterThan(0);
            expect(message).not.toBe(jaLabels.unavailable);
        }
        expect(new Set(messages).size).toBe(codes.length);
    });
});
