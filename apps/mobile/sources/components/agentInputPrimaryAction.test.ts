import { describe, expect, it } from 'vitest';
import { agentInputPrimaryActionDisabled, agentInputPrimaryActionLabel, resolveAgentInputPrimaryAction } from './agentInputPrimaryAction';

describe('resolveAgentInputPrimaryAction', () => {
    const base = {
        hasComposerContent: false,
        isSendBlocked: false,
        isSendDisabled: false,
        showAbortButton: false,
        canAbort: true,
    };

    it('shows Stop for a blank composer while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
        })).toBe('stop');
    });

    it('switches to Send as soon as a follow-up has content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            showAbortButton: true,
        })).toBe('send');
    });

    it('does not show Stop when there is no abort handler', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canAbort: false,
        })).toBe('idle');
    });

    it('keeps an empty idle composer inactive', () => {
        expect(resolveAgentInputPrimaryAction(base)).toBe('idle');
    });

    it('falls back to voice on an empty composer when dictation is available', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canVoice: true,
        })).toBe('voice');
    });

    it('keeps Stop ahead of voice while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canVoice: true,
        })).toBe('stop');
    });

    it('keeps Send ahead of voice once there is content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            canVoice: true,
        })).toBe('send');
    });

    it('still offers Stop for a blank composer when steering is blocked', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            isSendBlocked: true,
            showAbortButton: true,
            canVoice: true,
        })).toBe('stop');
    });

    it('preserves the blocked-send affordance for content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            isSendBlocked: true,
            showAbortButton: true,
        })).toBe('blocked');
    });

    it('keeps verified Claude cancel reachable when an unverified active send retains a draft', () => {
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true, isSendBlocked: true,
            showAbortButton: true, stopWhenSendBlocked: true })).toBe('stop');
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true, isSendBlocked: false,
            showAbortButton: true, stopWhenSendBlocked: true })).toBe('send');
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true, isSendBlocked: true,
            showAbortButton: true, canAbort: false, stopWhenSendBlocked: true })).toBe('blocked');
    });
});

describe('primary action accessibility identity', () => {
    const labels = { send: 'Send', stop: 'Stop', voice: 'Voice', readOnly: 'Read only', unavailable: 'Unavailable' };
    const base = { hasComposerContent: false, isSendBlocked: false, isSendDisabled: false, showAbortButton: false, canAbort: true };

    it('names a locked retained draft and a locked empty composer as read-only', () => {
        for (const hasComposerContent of [true, false]) {
            const action = resolveAgentInputPrimaryAction({ ...base, hasComposerContent, isSendBlocked: true });
            expect(agentInputPrimaryActionLabel(action, true, true, labels)).toBe('Read only');
            expect(agentInputPrimaryActionDisabled(action, action !== 'idle', true)).toBe(true);
        }
    });

    it('distinguishes an unavailable editable source from a readonly retained draft', () => {
        const action = resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true, isSendBlocked: true });
        expect(agentInputPrimaryActionLabel(action, true, false, labels)).toBe('Unavailable');
        expect(agentInputPrimaryActionDisabled(action, true, false)).toBe(false);
    });

    it('retains actual Stop, Send and Voice names including Stop when steering is blocked', () => {
        const stop = resolveAgentInputPrimaryAction({ ...base, isSendBlocked: true, showAbortButton: true });
        expect(agentInputPrimaryActionLabel(stop, true, false, labels)).toBe('Stop');
        expect(agentInputPrimaryActionDisabled(stop, true, true)).toBe(false);
        const send = resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true, showAbortButton: true });
        expect(agentInputPrimaryActionLabel(send, false, false, labels)).toBe('Send');
        const voice = resolveAgentInputPrimaryAction({ ...base, canVoice: true });
        expect(agentInputPrimaryActionLabel(voice, false, false, labels)).toBe('Voice');
    });
});
