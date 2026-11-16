import { expect, it } from 'vitest';
import { codeLightSourceAppName, codeLightSourceLabel, isCodeLightSessionIdentity, isCodeLightSessionSource } from './codeLightSourceScope';

const antigravity = { app: 'antigravity', id: 'original-cascade', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'verified-owner-1' };

it('requires explicit Antigravity native protocol and owner evidence while preserving Codex legacy mode', () => {
    expect(isCodeLightSessionSource({ app: 'codex' }, undefined)).toBe(true);
    expect(isCodeLightSessionSource({ app: 'codex', kind: 'session' }, 'session')).toBe(true);
    expect(isCodeLightSessionSource(antigravity, 'session')).toBe(true);
    for (const source of [
        { ...antigravity, kind: undefined }, { ...antigravity, kind: 'window' },
        { ...antigravity, protocol: undefined }, { ...antigravity, protocol: 'agy-cli' },
        { ...antigravity, runtimeGeneration: null }, { ...antigravity, runtimeGeneration: ' ' },
        { ...antigravity, id: undefined }, { ...antigravity, hostId: 'local' }, { ...antigravity, hostId: 'local:antigravity:unverified' },
        { ...antigravity, app: 'claude-desktop' },
    ]) expect(isCodeLightSessionSource(source, 'session')).toBe(false);
    for (const mode of [undefined, 'window', 'unknown']) expect(isCodeLightSessionSource(antigravity, mode)).toBe(false);
    expect(isCodeLightSessionSource({ app: 'codex', kind: 'window' }, undefined)).toBe(false);
    expect(isCodeLightSessionSource(null, 'session')).toBe(false);
});

it('keeps application labels separate from historical harness aliases', () => {
    expect(codeLightSourceAppName('codex')).toBe('Codex');
    expect(codeLightSourceAppName('antigravity')).toBe('Antigravity');
    expect(codeLightSourceAppName('claude-desktop')).toBe('Claude Desktop');
    expect(codeLightSourceAppName('agy')).toBe('');
});

it('requires exact Claude collection and native namespace, with independent catalog identity and mode labels', () => {
    const source = { app: 'claude-desktop', id: 'original', kind: 'session', protocol: 'claude-desktop-native',
        hostId: 'local:claude-desktop:' + 'b'.repeat(64), runtimeGeneration: 'owner', appMode: 'code', nativeCollection: 'claude-code-sessions' };
    expect(isCodeLightSessionSource(source, 'session')).toBe(true);
    expect(codeLightSourceLabel(source)).toBe('Claude Desktop · Code');
    const chat = { ...source, appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' };
    expect(isCodeLightSessionSource(chat, 'session')).toBe(true);
    expect(codeLightSourceLabel(chat)).toBe('Claude Desktop · Chat');
    for (const change of [{ protocol: 'claude-cli' }, { nativeCollection: 'local-agent-mode-sessions' }, { appMode: undefined }, { hostId: 'local' }, { kind: 'window' }]) {
        expect(isCodeLightSessionSource({ ...source, ...change }, 'session')).toBe(false);
    }
    expect(isCodeLightSessionIdentity({ ...source, runtimeGeneration: null }, 'session')).toBe(true);
    expect(isCodeLightSessionSource({ ...source, runtimeGeneration: null }, 'session')).toBe(false);
});
