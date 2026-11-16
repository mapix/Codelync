import { describe, expect, it } from 'vitest';
import { codeLightNativeCommand, codeLightSourceCommands, codeLightSlashSubmission, handleCodeLightSlashSubmission } from './codeLightNativeCommands';
import type { Metadata } from '@/sync/storageTypes';
import { MetadataSchema } from '@/sync/storageTypes';

function source(app: 'codex' | 'antigravity') {
    return {
        client: { id: 'noninvasive-bridge' }, capabilities: { rpcMethods: ['source-command'] },
        bridge: { source: { app, id: 'same-native-id', hostId: app === 'codex' ? 'local' : 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: app === 'antigravity' ? 'antigravity-connect' : undefined, runtimeGeneration: 'original-owner', windowGeneration: null },
            controlMode: 'session', sourceStatus: 'connected', currentTurnId: null },
        nativeControls: { model: { available: true, current: { model: app + '-model', reasoningEffort: null }, models: [], selectionMode: app === 'antigravity' ? 'next-message' : 'original-owner', selectionState: 'staged' },
            compatibility: { app, appVersion: app === 'codex' ? '26.1103.60933' : '2.31.2', protocol: 'fixture-native', protocolVersion: 1, supported: true },
            commands: { available: true, source: `original-${app}`, complete: false, skillsAvailable: false, items: [
                { name: 'compact', type: 'system', execution: app === 'codex' ? 'native-action' : 'unsupported', requiresIdle: true },
                { name: app === 'codex' ? 'model' : 'swarm', type: 'system', execution: app === 'codex' ? 'model-picker' : 'native-item' },
            ] } },
    } as unknown as Metadata;
}

describe('source-specific native command contracts', () => {
    it('accepts only a catalogue-confirmed native action; native items are ordinary explicit source messages', () => {
        expect(codeLightNativeCommand(source('codex'), '/compact')).toEqual({ name: 'compact', arguments: '' });
        expect(codeLightNativeCommand(source('codex'), '/model')).toBeNull();
        expect(codeLightNativeCommand(source('antigravity'), '/swarm task')).toBeNull();
        expect(codeLightNativeCommand(source('antigravity'), '/compact')).toBeNull();
    });
    it('refuses stale, foreign, unknown protocol and missing-owner catalogues', () => {
        const value = source('antigravity');
        value.nativeControls!.commands!.source = 'original-codex'; expect(codeLightSourceCommands(value)).toEqual([]);
        value.nativeControls!.commands!.source = 'original-antigravity'; value.nativeControls!.compatibility!.app = 'codex'; expect(codeLightSourceCommands(value)).toEqual([]);
        value.nativeControls!.compatibility!.app = 'antigravity'; value.bridge!.source.protocol = 'unknown'; expect(codeLightSourceCommands(value)).toEqual([]);
        value.bridge!.source.protocol = 'antigravity-connect'; value.bridge!.source.runtimeGeneration = null; expect(codeLightSourceCommands(value)).toEqual([]);
        value.bridge!.source.runtimeGeneration = 'owner'; value.bridge!.sourceStatus = 'disconnected'; expect(codeLightSourceCommands(value)).toEqual([]);
    });
    it('preserves version, partial-catalogue and staged-model semantics through the real metadata schema', () => {
        const parsed = MetadataSchema.pick({ nativeControls: true }).parse(source('antigravity'));
        expect(parsed.nativeControls?.compatibility?.appVersion).toBe('2.31.2');
        expect(parsed.nativeControls?.commands?.complete).toBe(false);
        expect(parsed.nativeControls?.model.selectionMode).toBe('next-message');
        expect(parsed.nativeControls?.model.selectionState).toBe('staged');
    });
    it('blocks hand-typed unsupported and unknown commands instead of treating them as model text', () => {
        const value = source('codex');
        value.nativeControls!.commands!.items.push({ name: 'goal', execution: 'unsupported' });
        expect(codeLightSlashSubmission(value, '/goal finish the task')).toEqual({ kind: 'blocked', reason: 'unsupported' });
        expect(codeLightSlashSubmission(value, '/missing custom argument')).toEqual({ kind: 'blocked', reason: 'unknown' });
        expect(codeLightSlashSubmission(source('antigravity'), '/compact')).toEqual({ kind: 'blocked', reason: 'unsupported' });
        expect(codeLightSlashSubmission(value, '/etc/hosts contains a name')).toEqual({ kind: 'message' });
        expect(codeLightSlashSubmission(value, 'Explain /goal')).toEqual({ kind: 'message' });
    });
    it('routes model-picker and blocked drafts without native/model dispatch or draft mutation', () => {
        const value = source('codex'); value.nativeControls!.commands!.items.push({ name: 'goal', execution: 'unsupported' });
        const events: string[] = [];
        const draft = { text: '/model' };
        const actions = { nativeAction: () => events.push('native'), modelPicker: () => events.push('model-menu'), blocked: () => events.push('notice') };
        const send = () => { if (!handleCodeLightSlashSubmission(value, draft.text, actions)) events.push('model-send'); };
        send(); expect(events).toEqual(['model-menu']); expect(draft.text).toBe('/model');
        events.length = 0; draft.text = '/goal task'; send(); expect(events).toEqual(['notice']); expect(draft.text).toBe('/goal task');
        events.length = 0; draft.text = '/unknown'; send(); expect(events).toEqual(['notice']); expect(draft.text).toBe('/unknown');
        events.length = 0; draft.text = '/etc/hosts'; send(); expect(events).toEqual(['model-send']); expect(draft.text).toBe('/etc/hosts');
    });
    it('retains the exact compact native action gate and native-item route', () => {
        const value = source('codex');
        expect(codeLightSlashSubmission(value, '/compact')).toEqual({ kind: 'native-action', command: { name: 'compact', arguments: '' } });
        expect(codeLightSlashSubmission(value, '/compact extra')).toEqual({ kind: 'blocked', reason: 'unsupported' });
        value.bridge!.currentTurnId = 'running'; expect(codeLightSlashSubmission(value, '/compact')).toEqual({ kind: 'blocked', reason: 'busy' });
        expect(codeLightSlashSubmission(source('antigravity'), '/swarm explicit task')).toEqual({ kind: 'native-item' });
    });
    it('an unavailable or source-mismatched catalogue cannot become ordinary slash input', () => {
        const value = source('codex'); value.nativeControls!.commands!.available = false;
        expect(codeLightSlashSubmission(value, '/compact')).toEqual({ kind: 'blocked', reason: 'unavailable' });
        value.nativeControls!.commands!.available = true; value.nativeControls!.compatibility!.app = 'antigravity';
        expect(codeLightSlashSubmission(value, '/model')).toEqual({ kind: 'blocked', reason: 'unavailable' });
    });
});
