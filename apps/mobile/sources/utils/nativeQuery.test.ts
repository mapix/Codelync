import { expect, it } from 'vitest';
import { AgentStateSchema } from '@/sync/storageTypes';
import { canReadFromNoninvasiveSource, canSendToNoninvasiveSource, getNoninvasiveTurnId } from '@/sync/noninvasiveBridge';
import { rigCanAbort } from '@/sync/rig';
import { nativeSubagentInputReadOnly } from './nativeParentControl';
import { nativeQueryCanCancel, nativeQueryCanSend, prepareNativeQueryCancel, readNativeQuery } from './nativeQuery';

function fixture(mode: 'code' | 'chat' = 'code') {
    const host = 'local:claude-desktop:' + 'a'.repeat(64);
    return { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, machineId: 'machine',
        nativeSession: { isSubagent: false, catalogueAvailable: true },
        bridge: { source: { app: 'claude-desktop', id: 'original', hostId: host, runtimeGeneration: 'owner', kind: 'session',
            protocol: 'claude-desktop-native', appMode: mode, nativeCollection: mode === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions' },
            controlMode: 'session', sourceStatus: 'connected', currentTurnId: null },
        capabilities: { send: true, steering: false, abort: true, rpcMethods: ['abort'] } },
        agentState: { nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: 'original', hostId: host,
            ownerGeneration: 'owner', queryToken: null, status: 'idle', canSend: true, activeSendMode: 'unverified', canCancel: false } } } as any;
}

it('permits verified idle input with no steering or fabricated native turn', () => {
    const session = fixture();
    expect(canReadFromNoninvasiveSource(session.metadata)).toBe(true);
    expect(canSendToNoninvasiveSource(session.metadata, session.agentState)).toBe(true);
    expect(getNoninvasiveTurnId(session.metadata)).toBeNull();
    expect(rigCanAbort(session.metadata, session.agentState)).toBe(false);
    session.metadata.capabilities.send = false;
    expect(canSendToNoninvasiveSource(session.metadata, session.agentState)).toBe(false);
    expect(canReadFromNoninvasiveSource(session.metadata)).toBe(true);
});

it('allows active Code input only through verified queue disposition; active Chat stays unavailable', () => {
    const session = fixture(); Object.assign(session.agentState.nativeQuery, { status: 'running', queryToken: 'query', canCancel: true, activeSendMode: 'queue' });
    expect(nativeQueryCanSend(session.metadata, session.agentState.nativeQuery)).toBe(true);
    session.agentState.nativeQuery.activeSendMode = 'unverified';
    expect(nativeQueryCanSend(session.metadata, session.agentState.nativeQuery)).toBe(false);
    const chat = fixture('chat'); Object.assign(chat.agentState.nativeQuery, { status: 'running', queryToken: 'query', canCancel: true, activeSendMode: 'queue' });
    expect(nativeQueryCanSend(chat.metadata, chat.agentState.nativeQuery)).toBe(false);
    expect(canReadFromNoninvasiveSource(chat.metadata)).toBe(true);
});

it('binds every query identity to exact source, collection and owner before enabling controls', () => {
    for (const change of [{ app: 'codex' }, { nativeConversationId: 'foreign' }, { hostId: 'foreign' }, { ownerGeneration: 'previous' }]) {
        const session = fixture(); Object.assign(session.agentState.nativeQuery, change);
        expect(readNativeQuery(session.metadata, session.agentState.nativeQuery)).toBeNull();
    }
    for (const change of [{ nativeCollection: 'local-agent-mode-sessions' }, { protocol: 'claude-cli' }, { kind: 'window' }, { runtimeGeneration: null }, { appMode: 'unknown' }]) {
        const session = fixture(); Object.assign(session.metadata.bridge.source, change);
        expect(readNativeQuery(session.metadata, session.agentState.nativeQuery)).toBeNull();
    }
    const session = fixture(); session.metadata.bridge.currentTurnId = 'fabricated-turn';
    expect(readNativeQuery(session.metadata, session.agentState.nativeQuery)).toBeNull();
    expect(getNoninvasiveTurnId(session.metadata)).toBeNull();
});

it('cancels the exact current query without a turn id and rejects a captured token or owner transition', () => {
    const session = fixture(); Object.assign(session.agentState.nativeQuery, { status: 'waiting', queryToken: 'query', canCancel: true, canSend: false });
    const expected = readNativeQuery(session.metadata, session.agentState.nativeQuery)!;
    expect(rigCanAbort(session.metadata, session.agentState)).toBe(true);
    expect(prepareNativeQueryCancel(session, expected)).toEqual({ queryToken: 'query' });
    session.agentState.nativeQuery.queryToken = 'next-query';
    expect(prepareNativeQueryCancel(session, expected)).toBeNull();
    session.agentState.nativeQuery.queryToken = 'query'; session.metadata.bridge.source.runtimeGeneration = 'next-owner';
    expect(prepareNativeQueryCancel(session, expected)).toBeNull();
});

it('keeps child and unavailable/saved-history restrictions ahead of valid query capability', () => {
    const session = fixture(); Object.assign(session.agentState.nativeQuery, { status: 'running', queryToken: 'query', canCancel: true, activeSendMode: 'queue' });
    session.metadata.nativeSession.isSubagent = true;
    expect(nativeSubagentInputReadOnly(session)).toBe(true);
    expect(canSendToNoninvasiveSource(session.metadata, session.agentState)).toBe(false);
    expect(nativeQueryCanCancel(session.metadata, session.agentState.nativeQuery)).toBe(false);
    expect(prepareNativeQueryCancel(session)).toBeNull();
    session.metadata.nativeSession.isSubagent = false; session.metadata.bridge.sourceStatus = 'history-only';
    expect(readNativeQuery(session.metadata, session.agentState.nativeQuery)).toBeNull();
});

it('drops malformed query capability without losing real request data', () => {
    const session = fixture(); session.agentState.nativeQuery.canCancel = true;
    const parsed = AgentStateSchema.parse({ nativeQuery: session.agentState.nativeQuery, requests: { request: { tool: 'Write', arguments: {} } } });
    expect(parsed.nativeQuery).toBeUndefined(); expect(parsed.requests?.request.tool).toBe('Write');
    for (const token of ['', ' ', 'q'.repeat(513)]) {
        Object.assign(session.agentState.nativeQuery, { status: 'running', queryToken: token, canCancel: true });
        expect(readNativeQuery(session.metadata, session.agentState.nativeQuery)).toBeNull();
    }
});
