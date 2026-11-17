import { expect, it } from 'vitest';
import { codelyncSourceAppName, codelyncSourceLabel, isCodelyncSessionIdentity, isCodelyncSessionSource } from './codelyncSourceScope';

const antigravity = { app: 'antigravity', id: 'original-cascade', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'verified-owner-1' };

it('requires explicit Antigravity native protocol and owner evidence while preserving Codex legacy mode', () => {
    expect(isCodelyncSessionSource({ app: 'codex' }, undefined)).toBe(true);
    expect(isCodelyncSessionSource({ app: 'codex', kind: 'session' }, 'session')).toBe(true);
    expect(isCodelyncSessionSource(antigravity, 'session')).toBe(true);
    for (const source of [
        { ...antigravity, kind: undefined }, { ...antigravity, kind: 'window' },
        { ...antigravity, protocol: undefined }, { ...antigravity, protocol: 'agy-cli' },
        { ...antigravity, runtimeGeneration: null }, { ...antigravity, runtimeGeneration: ' ' },
        { ...antigravity, id: undefined }, { ...antigravity, hostId: 'local' }, { ...antigravity, hostId: 'local:antigravity:unverified' },
        { ...antigravity, app: 'claude-desktop' },
    ]) expect(isCodelyncSessionSource(source, 'session')).toBe(false);
    for (const mode of [undefined, 'window', 'unknown']) expect(isCodelyncSessionSource(antigravity, mode)).toBe(false);
    expect(isCodelyncSessionSource({ app: 'codex', kind: 'window' }, undefined)).toBe(false);
    expect(isCodelyncSessionSource(null, 'session')).toBe(false);
});

it('keeps application labels separate from historical harness aliases', () => {
    expect(codelyncSourceAppName('codex')).toBe('Codex');
    expect(codelyncSourceAppName('antigravity')).toBe('Antigravity');
    expect(codelyncSourceAppName('claude-desktop')).toBe('Claude Desktop');
    expect(codelyncSourceAppName('agy')).toBe('');
});

it('requires exact Claude collection and native namespace, with independent catalog identity and mode labels', () => {
    const source = { app: 'claude-desktop', id: 'original', kind: 'session', protocol: 'claude-desktop-native',
        hostId: 'local:claude-desktop:' + 'b'.repeat(64), runtimeGeneration: 'owner', appMode: 'code', nativeCollection: 'claude-code-sessions' };
    expect(isCodelyncSessionSource(source, 'session')).toBe(true);
    expect(codelyncSourceLabel(source)).toBe('Claude Desktop · Code');
    const chat = { ...source, appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' };
    expect(isCodelyncSessionSource(chat, 'session')).toBe(true);
    expect(codelyncSourceLabel(chat)).toBe('Claude Desktop · Chat');
    for (const change of [{ protocol: 'claude-cli' }, { nativeCollection: 'local-agent-mode-sessions' }, { appMode: undefined }, { hostId: 'local' }, { kind: 'window' }]) {
        expect(isCodelyncSessionSource({ ...source, ...change }, 'session')).toBe(false);
    }
    expect(isCodelyncSessionIdentity({ ...source, runtimeGeneration: null }, 'session')).toBe(true);
    expect(isCodelyncSessionSource({ ...source, runtimeGeneration: null }, 'session')).toBe(false);
});
