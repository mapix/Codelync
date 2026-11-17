import * as React from 'react';
import { View } from 'react-native';
import { CodelyncMark } from './CodelyncMark';

const HEADER_LOGO_SIZE = 19;

/**
 * Shared header logo component used across all main tabs.
 * Extracted to prevent flickering on tab switches - when each tab
 * had its own HeaderLeft, the component would unmount/remount.
 */
export const HeaderLogo = React.memo(() => {
    return (
        <View style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <CodelyncMark size={HEADER_LOGO_SIZE} />
        </View>
    );
});
