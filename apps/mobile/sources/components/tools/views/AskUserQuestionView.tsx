import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { storage, useSession, useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestion,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';

interface AskUserQuestionInput {
    questions?: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
}

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId, metadata }) => {
    const session = useSession(sessionId ?? ''), sourceMetadata = session?.metadata ?? metadata;
    const writesBlocked = nativeWriteConnectionBlocked(sourceMetadata, useSocketStatus().status === 'connected');
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = React.useMemo<InlineQuestion[]>(() => (
        (input?.questions ?? []).map((question, index) => ({
            ...question,
            id: `question-${index}`,
            required: true,
        }))
    ), [input?.questions]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !tool.permission?.id) return;
        if (nativeWriteConnectionBlocked(storage.getState().sessions[sessionId]?.metadata ?? sourceMetadata, apiSocket.peerConnected())) throw Object.assign(Error('The connection is unavailable'), { effectMayHaveOccurred: false });

        const providerAnswers: Record<string, string> = {};
        questions.forEach((question, index) => {
            const originalQuestion = input?.questions?.[index];
            const selected = answers[question.id];
            if (originalQuestion && selected?.length) {
                providerAnswers[originalQuestion.question] = selected.join(', ');
            }
        });

        // Claude resolves AskUserQuestion through its permission callback and
        // expects the chosen values merged into the tool input.
        await sessionAllow(
            sessionId,
            tool.permission.id,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswers },
        );
    }, [input?.questions, questions, sessionId, tool.permission?.id, sourceMetadata]);

    if (questions.length === 0) return null;

    return (
        <InlineQuestionForm
            questions={questions}
            canInteract={tool.state === 'running' && !writesBlocked}
            submittedAnswers={tool.state === 'completed' ? {} : undefined}
            onSubmit={handleSubmit}
        />
    );
});
