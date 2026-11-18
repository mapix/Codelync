import * as React from 'react';
import { ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    accessibilityLabel?: string;
}

export const StatusDot = React.memo(({ color, isPulsing, size = 6, style, accessibilityLabel }: StatusDotProps) => {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        if (isPulsing) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1, // infinite
                true // reverse
            );
        } else {
            opacity.value = withTiming(1, { duration: 200 });
        }
    }, [isPulsing]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <Animated.View
            accessible={!!accessibilityLabel}
            accessibilityRole={accessibilityLabel ? 'text' : undefined}
            accessibilityLabel={accessibilityLabel}
            importantForAccessibility={accessibilityLabel ? 'yes' : 'no'}
            style={[
                baseStyle,
                animatedStyle,
                style
            ]}
        />
    );
});