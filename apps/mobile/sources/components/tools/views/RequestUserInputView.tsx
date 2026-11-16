import * as React from 'react';

import { sessionAnswerQuestion } from '@/sync/ops';
import { storage, useSession, useSessionAgentFormCommunication, useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';
import type { AgentQuestionAnswer } from '@/sync/storageTypes';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';

/** Inline renderer for Happy/Codex request_user_input communications. */
export const RequestUserInputView = React.memo<ToolViewProps>(({ tool, sessionId, metadata }) => {
    const session = useSession(sessionId ?? ''), sourceMetadata = session?.metadata ?? metadata;
    const writesBlocked = nativeWriteConnectionBlocked(sourceMetadata, useSocketStatus().status === 'connected');
    const communication = useSessionAgentFormCommunication(sessionId ?? '', tool.callId ?? '');

    const submittedAnswers = React.useMemo<InlineQuestionAnswers | null>(() => {
        if (!communication || communication.status === 'pending') return null;
        if (communication.status === 'cancelled' || !communication.answers) return {};
        const answers: InlineQuestionAnswers = {};
        for (const [questionId, answer] of Object.entries(communication.answers)) {
            const values = [...answer.options];
            if (answer.custom) values.push(answer.custom);
            answers[questionId] = values;
        }
        return answers;
    }, [communication]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !communication || communication.status !== 'pending') return;
        if (nativeWriteConnectionBlocked(storage.getState().sessions[sessionId]?.metadata ?? sourceMetadata, apiSocket.peerConnected())) throw Object.assign(Error('The connection is unavailable'), { effectMayHaveOccurred: false });

        const communicationAnswers: Record<string, AgentQuestionAnswer> = {};
        for (const question of communication.questions) {
            const selected = answers[question.id];
            if (!selected?.length) continue;
            communicationAnswers[question.id] = {
                options: question.multiSelect
                    ? selected
                    : selected.slice(0, 1),
            };
        }
        await sessionAnswerQuestion(sessionId, communication.id, communicationAnswers, communication.kind);
    }, [communication, sessionId, sourceMetadata]);

    if (!communication || communication.questions.some(question => question.options.length === 0)) {
        return null;
    }

    return (
        <InlineQuestionForm
            questions={communication.questions}
            canInteract={tool.state === 'running' && communication.status === 'pending' && !writesBlocked}
            submittedAnswers={submittedAnswers}
            onSubmit={handleSubmit}
        />
    );
});
