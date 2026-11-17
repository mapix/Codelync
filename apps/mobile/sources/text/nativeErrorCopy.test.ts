import { expect, it } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES } from './_all';
import { nativeSessionAvailabilityLabels } from './nativeSessionAvailabilityLabels';
import { nativeParentControlLabels } from './nativeParentControlLabels';
import { codelyncTaskLabels } from './codelyncTaskLabels';
import { codelyncSubagentLabels } from './codelyncSubagentLabels';
import { nativeTaskActionLabels } from './nativeTaskActionLabels';
import { codelyncMediaLabels } from './codelyncMediaLabels';

it('all supported languages distinguish source, lock, permission, read, save and receipt recovery copy', () => {
    for (const language of SUPPORTED_LANGUAGE_CODES) {
        const source = nativeSessionAvailabilityLabels[language], action = nativeTaskActionLabels[language], media = codelyncMediaLabels[language];
        expect(new Set([source.sourceUnavailable, source.locked, source.permissionRequired, source.readFailed, source.connectionUnavailable]).size).toBe(5);
        expect(new Set([media.unavailable, media.loadFailed, media.saveFailed, media.saveUnavailable, media.videoTooLarge]).size).toBe(5);
        expect(action.unknown).not.toBe(action.stopFailed); expect(action.check).not.toBe(action.stop);
        for (const dictionary of [source, action, media, nativeParentControlLabels[language], codelyncTaskLabels[language], codelyncSubagentLabels[language]]) {
            expect(Object.values(dictionary).every(value => typeof value === 'object' || typeof value === 'string' && value.trim().length > 0)).toBe(true);
        }
        expect(media.videoTooLarge).toMatch(/1\s*(?:MB|МБ)/);
    }
    const ordinaryEnglish = [nativeSessionAvailabilityLabels.en, nativeParentControlLabels.en, codelyncTaskLabels.en, codelyncSubagentLabels.en, nativeTaskActionLabels.en, codelyncMediaLabels.en]
        .flatMap(dictionary => Object.values(dictionary).filter(value => typeof value === 'string')).join(' ');
    expect(ordinaryEnglish).not.toMatch(/\b(?:runtime|rpc|lease|manifest|contract|observer|catalog|native)\b/i);
});
