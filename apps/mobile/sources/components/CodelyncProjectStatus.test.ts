import * as React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', textLink: 'blue' } } }) }));
vi.mock('@/hooks/useCodelyncProjectActivity', () => ({ useCodelyncProjectActivity: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string, args?: { count: number }) => args ? `${key}:${args.count}` : key }));
import { CodelyncProjectStatusView } from './CodelyncProjectStatus';

it('confirmed partial project counts appear during cold discovery, with unconfirmed coverage visible', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodelyncProjectStatusView, { activity: { total: 29, active: 1, waiting: 0, unknown: 28, status: 'refreshing', observedAt: 1000 } })); });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('codelyncProjects.active:1');
    expect(text).toContain('codelyncProjects.unknown:28');
    expect(text).toContain('codelyncProjects.refreshing');
    act(() => renderer.unmount());
});

it('an unavailable or initial unverified project does not display false zero active/waiting counters', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodelyncProjectStatusView, { activity: { total: 29, active: 0, waiting: 0, unknown: 29, status: 'unavailable', observedAt: 0 } })); });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('codelyncProjects.unavailable');
    expect(text).not.toContain('codelyncProjects.active:0');
    act(() => renderer.unmount());
});
