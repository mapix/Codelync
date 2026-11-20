import * as React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', textLink: 'blue' } } }) }));
vi.mock('@/hooks/useCodelyncProjectActivity', () => ({ useCodelyncSessionActivity: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { CodelyncSessionStatusView } from './CodelyncSessionStatus';
const text = (known: boolean, active: boolean, waiting: boolean) => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodelyncSessionStatusView, { activity: { known, active, waiting, status: 'ready', observedAt: 1 } })); });
    const value = JSON.stringify(renderer.toJSON()); act(() => renderer.unmount()); return value;
};
it('each list row displays real runtime and waiting state, including their overlap', () => {
    expect(text(true, true, false)).toContain('codelyncSessionStatus.active');
    expect(text(true, true, true)).toContain('codelyncSessionStatus.waiting');
    expect(text(true, false, false)).toContain('codelyncSessionStatus.idle');
    expect(text(false, false, false)).toContain('codelyncSessionStatus.unknown');
    expect(text(false, false, false)).not.toContain('codelyncSessionStatus.idle');
});

it('retains last confirmed session label while status is refreshing, and drops to unknown on unavailable or unconfirmed', () => {
    const renderWith = (status: 'ready' | 'refreshing' | 'unavailable' | 'stale', known: boolean, observedAt: number) => {
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(React.createElement(CodelyncSessionStatusView, { activity: { known, active: true, waiting: false, status, observedAt } })); });
        const value = JSON.stringify(renderer.toJSON()); act(() => renderer.unmount()); return value;
    };
    expect(renderWith('refreshing', true, 1000)).toContain('codelyncSessionStatus.active');
    expect(renderWith('refreshing', true, 1000)).not.toContain('codelyncSessionStatus.unknown');
    expect(renderWith('refreshing', false, 0)).toContain('codelyncSessionStatus.unknown');
    expect(renderWith('unavailable', true, 1000)).toContain('codelyncSessionStatus.unknown');
});
