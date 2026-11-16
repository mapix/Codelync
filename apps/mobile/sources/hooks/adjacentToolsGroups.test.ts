import { expect, it, vi } from 'vitest';
import { groupMessagesForDisplay, ordinaryToolRunWindowEnd, retainToolsGroupIds, type DisplayItem, type ToolsGroupItem } from './useGroupedMessages';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const tool = (id: string, turn = 'original-turn'): ToolCallMessage => ({ kind: 'tool-call', id, localId: null, createdAt: 1, turn,
    tool: { name: 'Bash', state: 'completed', input: {}, createdAt: 1, startedAt: 1, completedAt: 2, description: '' }, children: [] });
const text = (id: string): Message => ({ kind: 'agent-text', id, localId: null, createdAt: 1, text: id });
const native = (messages: Message[], sessionId = 'original-session') => groupMessagesForDisplay(messages, true, { collapseAgentWork: false, adjacentTools: true, sessionId });
const groups = (items: DisplayItem[]) => items.filter((item): item is ToolsGroupItem => item.type === 'tools-group');

it('groups adjacent original tools while keeping intervening and final text independent', () => {
    const final = text('final'), between = text('between');
    const items = native([final, tool('tool-three'), tool('tool-two'), between, tool('tool-one')]);
    expect(items.map(item => item.type)).toEqual(['tools-group', 'message', 'tools-group', 'message']);
    expect(groups(items).map(group => group.messages.map(message => message.id))).toEqual([['tool-one'], ['tool-two', 'tool-three']]);
    expect(items[1]).toMatchObject({ type: 'message', message: between }); expect(items[3]).toMatchObject({ type: 'message', message: final });
});

it('permissions, attachments and distinct native turns end a tool run', () => {
    const permission = tool('permission'); permission.tool.permission = { id: 'original-permission', status: 'pending' };
    const file = tool('attachment'); file.tool.name = 'file';
    const items = native([tool('other-turn', 'next-turn'), tool('same-turn'), file, tool('before-file'), permission, tool('before-permission')]);
    expect(groups(items).every(group => group.messages.length === 1)).toBe(true);
    expect(items.filter(item => item.type === 'message').map(item => item.id)).toEqual(['permission', 'attachment']);
});

it('retains group and message identities when live rows or cached older rows extend it', () => {
    const initial = native([tool('two'), tool('one')]);
    const grown = retainToolsGroupIds(native([tool('three'), tool('two'), tool('one')]), initial);
    const older = retainToolsGroupIds(native([tool('three'), tool('two'), tool('one'), tool('earlier')]), grown);
    expect(groups(grown)[0].id).toBe(groups(initial)[0].id); expect(groups(older)[0].id).toBe(groups(initial)[0].id);
    expect(groups(older)[0].messages.map(message => message.id)).toEqual(['earlier', 'one', 'two', 'three']);
    expect(groups(native([tool('two'), tool('one')], 'another-session'))[0].id).not.toBe(groups(initial)[0].id);
});

it('extends only a retained adjacent tool boundary, preserving the next text anchor', () => {
    const messages = [tool('three'), tool('two'), tool('one'), text('prompt-context'), tool('older-tool')];
    expect(ordinaryToolRunWindowEnd(messages, 1)).toBe(3);
    expect(ordinaryToolRunWindowEnd(messages, 4)).toBe(4);
    expect(ordinaryToolRunWindowEnd([tool('new-turn', 'new'), tool('old-turn', 'old')], 1)).toBe(1);
});

it('an intervening text correction splits groups without duplicate keys or hiding the text', () => {
    const original = native([tool('three'), tool('two'), tool('one')]);
    const extended = retainToolsGroupIds(native([tool('three'), tool('two'), tool('one'), tool('earlier')]), original);
    const split = retainToolsGroupIds(native([tool('three'), tool('two'), tool('one'), text('visible-correction'), tool('earlier')]), extended);
    expect(new Set(groups(split).map(group => group.id)).size).toBe(2);
    expect(split.find(item => item.type === 'message')?.id).toBe('visible-correction');
    expect(groups(split).flatMap(group => group.messages.map(message => message.id))).toEqual(['earlier', 'one', 'two', 'three']);
});
