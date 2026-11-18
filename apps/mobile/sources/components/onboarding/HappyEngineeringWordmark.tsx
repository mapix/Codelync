import * as React from 'react';
import { Image, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
/** Keep the generated symbol; render the current product name as native text. */
export const HappyEngineeringWordmark = React.memo(function CodelyncWordmark({ height }: { height: number }) {
    const { theme } = useUnistyles();
    return <View testID="codelync-wordmark" accessible accessibilityLabel="Codelync" style={{ height, justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: Math.min(height, 80) }}>
            <Image source={require('@/assets/images/codelync-mark.png')} resizeMode="contain" style={{ width: 54, height: 54, borderRadius: 54 * 0.22 }} />
            <Text allowFontScaling={false} style={{ fontSize: 38, fontWeight: '800', color: theme.dark ? '#ffffff' : '#00248b' }}>Codelync</Text>
        </View>
    </View>;
});
