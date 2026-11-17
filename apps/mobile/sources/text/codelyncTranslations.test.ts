import { expect, it } from 'vitest';
import { en, type TranslationStructure } from './_default';
import { en as dedicatedEn } from './translations/en';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { it as italian } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { ja } from './translations/ja';
import { SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from './_all';

const translations: Record<SupportedLanguage, TranslationStructure> = {
    en, ru, pl, es, it: italian, pt, ca, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja,
};
const visibleGroups = ['codelyncSetup', 'codelyncPairing', 'codelyncModels', 'codelyncLoading', 'codelyncChannels', 'codelyncSessionStatus', 'sourceBridge'] as const;
const scanKeys = ['linkTitle', 'openBody', 'scanButton', 'linking', 'pasteLink', 'pasteLinkTitle', 'pasteLinkMessage', 'pasteLinkConfirm'] as const;

it.each(SUPPORTED_LANGUAGE_CODES)('%s provides all project counters and explicit current Codelync flow translations', (language) => {
    const translation = translations[language];
    expect(Object.keys(translation.codelyncSessionStatus).sort()).toEqual(['active', 'idle', 'unknown', 'waiting']);
    for (const key of ['active', 'waiting', 'idle', 'unknown'] as const) {
        const label = translation.codelyncSessionStatus[key];
        expect(typeof label).toBe('string');
        expect(label.trim().length).toBeGreaterThan(0);
        expect(label).not.toContain('\n');
        if (language !== 'en') expect(label).not.toBe(en.codelyncSessionStatus[key]);
    }
    expect(Object.keys(translation.codelyncProjects).sort()).toEqual(Object.keys(en.codelyncProjects).sort());
    for (const count of [0, 1, 12]) {
        for (const key of ['active', 'waiting', 'unknown', 'total'] as const) {
            const text = translation.codelyncProjects[key]({ count });
            expect(text).toContain(String(count));
            expect(text).not.toContain('{count}');
        }
    }
    expect(translation.codelyncProjects.updated({ time: '09:30' })).toContain('09:30');
    for (const key of ['offline', 'stale', 'refreshing', 'unavailable'] as const) expect(translation.codelyncProjects[key].length).toBeGreaterThan(0);
    expect(translation.codelyncLoading.unavailable.trim().length).toBeGreaterThan(0);
    if (language !== 'en') expect(translation.codelyncLoading.unavailable).not.toBe(en.codelyncLoading.unavailable);
    for (const key of scanKeys) {
        expect(translation.onboarding[key].length).toBeGreaterThan(0);
        if (language !== 'en') expect(translation.onboarding[key]).not.toBe(en.onboarding[key]);
    }
    if (language !== 'en') {
        for (const group of visibleGroups) expect(JSON.stringify(translation[group])).not.toBe(JSON.stringify(en[group]));
    }
    expect(translation.settings.aboutFooter).toContain('Codex');
    expect(translation.settings.aboutFooter).toContain('Antigravity');
    expect(translation.settings.aboutFooter).toContain('Claude Desktop');
    expect(translation.settings.aboutFooter).toContain('Gateway');
    expect(translation.welcome.title).toContain('Codex');
    expect(translation.welcome.title).toContain('Antigravity');
    expect(translation.welcome.title).toContain('Claude Desktop');
    expect(translation.sourceBridge.waiting).not.toContain('Codex');
    expect(translation.sourceBridge.openFailed).not.toContain('Codex');
    expect(translation.codelyncSetup.helpBody).not.toContain('start-codelync.sh');
    expect(translation.onboarding.terminalRun).toBe('open /Applications/Codelync.app');
});

it('keeps the dedicated English mirror in sync for current Codelync features', () => {
    for (const group of visibleGroups) expect(JSON.stringify(dedicatedEn[group])).toBe(JSON.stringify(en[group]));
    expect(dedicatedEn.codelyncProjects.updated({ time: '09:30' })).toBe(en.codelyncProjects.updated({ time: '09:30' }));
    expect(dedicatedEn.settings.aboutFooter).toBe(en.settings.aboutFooter);
});

it('uses the specified Chinese session status labels without inferring idle from unknown', () => {
    expect(zhHans.codelyncSessionStatus).toEqual({ active: '活跃', waiting: '待操作', idle: '空闲', unknown: '未确认' });
    expect(zhHant.codelyncSessionStatus).toEqual({ active: '活躍', waiting: '待操作', idle: '空閒', unknown: '未確認' });
});
