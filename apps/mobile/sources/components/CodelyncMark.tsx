import * as React from 'react';
import { Image } from 'react-native';

export const CodelyncMark = React.memo(function CodelyncMark({ size = 24 }: { size?: number }) {
    return <Image source={require('@/assets/images/codelync-mark.png')} accessibilityLabel="Codelync" style={{ width: size, height: size, borderRadius: size * 0.22 }} />;
});
