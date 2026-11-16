export type AgentInputPrimaryAction = 'send' | 'stop' | 'blocked' | 'voice' | 'idle';

/** Name the rendered action without advertising a blocked native mutation. */
export function agentInputPrimaryActionLabel(action: AgentInputPrimaryAction, blocked: boolean, readOnly: boolean,
    labels: { send: string; stop: string; voice: string; readOnly: string; unavailable: string }): string {
    if (action === 'stop') return labels.stop;
    if (action === 'voice') return labels.voice;
    if (blocked) return readOnly ? labels.readOnly : labels.unavailable;
    return labels.send;
}

export function agentInputPrimaryActionDisabled(action: AgentInputPrimaryAction, canPress: boolean, readOnly: boolean): boolean {
    return !canPress || readOnly && action === 'blocked';
}

export function resolveAgentInputPrimaryAction({
    hasComposerContent,
    isSendBlocked,
    isSendDisabled,
    showAbortButton,
    canAbort,
    canVoice = false,
    stopWhenSendBlocked = false,
}: {
    hasComposerContent: boolean;
    isSendBlocked: boolean;
    isSendDisabled: boolean;
    showAbortButton: boolean;
    canAbort: boolean;
    canVoice?: boolean;
    stopWhenSendBlocked?: boolean;
}): AgentInputPrimaryAction {
    // A blank composer while the agent is working is the one case where the
    // primary control is Stop. As soon as the user starts a follow-up, sending
    // takes priority so the next message can be queued without aborting work.
    // A blocked send must not suppress Stop: an agent that refuses steering
    // while it thinks is exactly the one the user has no other way to stop.
    if (showAbortButton && canAbort && (!hasComposerContent || stopWhenSendBlocked && isSendBlocked)) {
        return 'stop';
    }
    if (isSendBlocked && hasComposerContent) {
        return 'blocked';
    }
    if (!isSendDisabled && hasComposerContent) {
        return 'send';
    }
    // An empty composer with dictation available falls back to voice rather
    // than to a dead button, which is what the separate mic button used to do.
    if (!isSendDisabled && canVoice) {
        return 'voice';
    }
    return 'idle';
}
