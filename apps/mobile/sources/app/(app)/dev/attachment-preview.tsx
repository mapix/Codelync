import * as React from 'react';
import { View, Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { FileView } from '@/components/tools/views/FileView';
import type { ToolCall } from '@/sync/typesMessage';

/** Explicit component/transport QA. This does not publish a native conversation item. */
export default function AttachmentPreviewQA() {
    const params = useLocalSearchParams<{ session?: string; ref?: string; name?: string; mime?: string }>();
    const { theme } = useUnistyles();
    const session = useSession(typeof params.session === 'string' ? params.session : '');
    const valid = !!session && typeof params.ref === 'string' && params.ref.length > 0 && params.ref.length <= 1024
        && typeof params.name === 'string' && params.name.length <= 128 && typeof params.mime === 'string' && params.mime.length <= 128;
    const tool: ToolCall = { name: 'file', state: 'completed', createdAt: 0, startedAt: null, completedAt: null, description: null,
        input: { ref: params.ref, name: params.name, mimeType: params.mime } };
    return <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
        <Stack.Screen options={{ title: 'Attachment preview QA' }} />
        {valid && session ? <FileView tool={tool} metadata={session.metadata} messages={[]} sessionId={session.id} />
            : <Text style={{ padding: 20, color: theme.colors.textSecondary }}>Stored session and attachment reference required.</Text>}
    </View>;
}
