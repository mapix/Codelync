import * as React from 'react';
import { 
    ScrollView, 
    View, 
    StyleProp, 
    ViewStyle,
    Platform,
    ScrollViewProps
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ItemListProps extends ScrollViewProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        paddingBottom: Platform.select({ ios: 34, default: 16 }),
        paddingTop: 0,
    },
}));

export const ItemList = React.memo<ItemListProps>((props) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const styles = stylesheet;
    
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true,
        ...scrollViewProps
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';
    
    const backgroundColor = theme.colors.groupped.background;
    const baseBottom = isIOS ? 34 : 16;

    return (
        <ScrollView 
            style={[
                styles.container,
                { backgroundColor },
                style
            ]}
            contentContainerStyle={[
                styles.contentContainer,
                {
                    paddingBottom: Math.max(baseBottom, (insets.bottom ?? 0) + 16),
                    paddingLeft: insets.left ?? 0,
                    paddingRight: insets.right ?? 0,
                },
                containerStyle
            ]}
            showsVerticalScrollIndicator={scrollViewProps.showsVerticalScrollIndicator !== undefined 
                ? scrollViewProps.showsVerticalScrollIndicator 
                : true}
            keyboardShouldPersistTaps={scrollViewProps.keyboardShouldPersistTaps ?? 'handled'}
            contentInsetAdjustmentBehavior={(isIOS && !isWeb) ? 'automatic' : undefined}
            {...scrollViewProps}
        >
            {children}
        </ScrollView>
    );
});

export const ItemListStatic = React.memo<Omit<ItemListProps, keyof ScrollViewProps> & {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}>((props) => {
    const { theme } = useUnistyles();
    
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';
    
    const backgroundColor = theme.colors.groupped.background;

    return (
        <View 
            style={[
                { backgroundColor },
                style
            ]}
        >
            <View style={containerStyle}>
                {children}
            </View>
        </View>
    );
});
