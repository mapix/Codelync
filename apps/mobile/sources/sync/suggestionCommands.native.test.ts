import { beforeEach, expect, it, vi } from 'vitest';
import type { Metadata, Session } from './storageTypes';
const state = vi.hoisted(() => ({ sessions: {} as Record<string, Session> }));
vi.mock('./storage', () => ({ storage: { getState: () => state } }));
import { searchCommands } from './suggestionCommands';

function session(app: 'codex' | 'antigravity'): Session {
    return { id: app, metadata: { client: { id: 'noninvasive-bridge' }, slashCommands: ['foreign-legacy-command'],
        bridge: { source: { app, id: 'same-id', hostId: app === 'codex' ? 'local' : 'local:antigravity:' + 'b'.repeat(64), kind: 'session', protocol: app === 'antigravity' ? 'antigravity-connect' : undefined, runtimeGeneration: 'owner', windowGeneration: null }, controlMode: 'session', sourceStatus: 'connected', currentTurnId: null },
        nativeControls: { compatibility: { app, appVersion: 'fixture-version', protocol: 'fixture', protocolVersion: 1, supported: true }, model: { available: false, current: null, models: [] },
            commands: { available: true, source: `original-${app}`, items: app === 'codex' ? [{ name: 'compact', execution: 'native-action', requiresIdle: true }, { name: 'model', execution: 'model-picker' }, { name: 'goal', execution: 'unsupported' }] : [{ name: 'swarm', execution: 'native-item' }, { name: 'boost', execution: 'native-item' }] } } } as unknown as Metadata } as Session;
}
beforeEach(() => { state.sessions = { codex: session('codex'), antigravity: session('antigravity') }; });
it('uses each native source catalogue without shared defaults or legacy commands', async () => {
    expect((await searchCommands('codex', '')).map(item => item.command)).toEqual(['compact']);
    expect((await searchCommands('antigravity', '')).map(item => item.command)).toEqual(['swarm', 'boost']);
    expect(await searchCommands('codex', 'boost')).toEqual([]);
});
it('unavailable or running native command gates never fall back to default slash commands', async () => {
    state.sessions.codex.metadata!.bridge!.currentTurnId = 'active';
    expect(await searchCommands('codex', '')).toEqual([]);
    state.sessions.antigravity.metadata!.nativeControls!.commands!.available = false;
    expect(await searchCommands('antigravity', '')).toEqual([]);
    delete state.sessions.antigravity.metadata!.nativeControls;
    expect(await searchCommands('antigravity', '')).toEqual([]);
});
