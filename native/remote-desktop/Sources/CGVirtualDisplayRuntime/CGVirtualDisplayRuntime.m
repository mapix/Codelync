#import "CGVirtualDisplayRuntime.h"
#import <objc/runtime.h>

@protocol CLPrivateVirtualDisplayDescriptorObjC <NSObject>
- (nullable instancetype)init;
- (void)setName:(NSString *)name;
- (void)setMaxPixelsWide:(uint32_t)maxPixelsWide;
- (void)setMaxPixelsHigh:(uint32_t)maxPixelsHigh;
- (void)setSizeInMillimeters:(CGSize)sizeInMillimeters;
- (void)setVendorID:(uint32_t)vendorID;
- (void)setProductID:(uint32_t)productID;
- (void)setSerialNum:(uint32_t)serialNum;
@optional
- (void)setQueue:(nullable dispatch_queue_t)queue;
- (void)setTerminationHandler:(nullable void (^)(id, id))handler;
@end

@protocol CLPrivateVirtualDisplayModeObjC <NSObject>
- (nullable instancetype)initWithWidth:(uint32_t)width
                                height:(uint32_t)height
                           refreshRate:(double)refreshRate;
@end

@protocol CLPrivateVirtualDisplaySettingsObjC <NSObject>
- (nullable instancetype)init;
- (void)setHiDPI:(uint32_t)hiDPI;
- (void)setModes:(NSArray *)modes;
@end

@protocol CLPrivateVirtualDisplayObjC <NSObject>
- (nullable instancetype)initWithDescriptor:(id)descriptor;
- (BOOL)applySettings:(id)settings;
- (CGDirectDisplayID)displayID;
@end

typedef struct {
    Class _Nullable displayClass;
    Class _Nullable descriptorClass;
    Class _Nullable settingsClass;
    Class _Nullable modeClass;
    BOOL supported;
} CLResolvedVirtualDisplayClasses;

static CLResolvedVirtualDisplayClasses CLResolveClassesWithNames(
    const char * _Nullable displayName,
    const char * _Nullable descriptorName,
    const char * _Nullable settingsName,
    const char * _Nullable modeName
) {
    // Ensure CoreGraphics framework Objective-C classes are initialized before lookup.
    (void)CGMainDisplayID();

    CLResolvedVirtualDisplayClasses out = { Nil, Nil, Nil, Nil, NO };
    if (displayName == NULL || descriptorName == NULL || settingsName == NULL || modeName == NULL) {
        return out;
    }

    Class displayClass = objc_lookUpClass(displayName);
    Class descriptorClass = objc_lookUpClass(descriptorName);
    Class settingsClass = objc_lookUpClass(settingsName);
    Class modeClass = objc_lookUpClass(modeName);
    if (displayClass == Nil || descriptorClass == Nil || settingsClass == Nil || modeClass == Nil) {
        return out;
    }

    SEL descriptorRequired[] = {
        @selector(init),
        @selector(setName:),
        @selector(setMaxPixelsWide:),
        @selector(setMaxPixelsHigh:),
        @selector(setSizeInMillimeters:),
        @selector(setVendorID:),
        @selector(setProductID:),
        @selector(setSerialNum:)
    };
    for (size_t i = 0; i < sizeof(descriptorRequired) / sizeof(descriptorRequired[0]); i++) {
        if (![descriptorClass instancesRespondToSelector:descriptorRequired[i]]) {
            return out;
        }
    }

    if (![modeClass instancesRespondToSelector:@selector(initWithWidth:height:refreshRate:)]) {
        return out;
    }

    SEL settingsRequired[] = {
        @selector(init),
        @selector(setHiDPI:),
        @selector(setModes:)
    };
    for (size_t i = 0; i < sizeof(settingsRequired) / sizeof(settingsRequired[0]); i++) {
        if (![settingsClass instancesRespondToSelector:settingsRequired[i]]) {
            return out;
        }
    }

    SEL displayRequired[] = {
        @selector(initWithDescriptor:),
        @selector(applySettings:),
        @selector(displayID)
    };
    for (size_t i = 0; i < sizeof(displayRequired) / sizeof(displayRequired[0]); i++) {
        if (![displayClass instancesRespondToSelector:displayRequired[i]]) {
            return out;
        }
    }

    out.displayClass = displayClass;
    out.descriptorClass = descriptorClass;
    out.settingsClass = settingsClass;
    out.modeClass = modeClass;
    out.supported = YES;
    return out;
}

static CLResolvedVirtualDisplayClasses CLResolveDefaultClasses(void) {
    return CLResolveClassesWithNames(
        "CGVirtualDisplay",
        "CGVirtualDisplayDescriptor",
        "CGVirtualDisplaySettings",
        "CGVirtualDisplayMode"
    );
}

BOOL CLVirtualDisplayRuntimeProbeClassNames(
    NSString *displayClassName,
    NSString *descriptorClassName,
    NSString *settingsClassName,
    NSString *modeClassName
) {
    return CLResolveClassesWithNames(
        displayClassName.UTF8String,
        descriptorClassName.UTF8String,
        settingsClassName.UTF8String,
        modeClassName.UTF8String
    ).supported;
}

BOOL CLVirtualDisplayRuntimeIsSupported(void) {
    static BOOL supported = NO;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        supported = CLResolveDefaultClasses().supported;
    });
    return supported;
}

static id _Nullable CLBuildSettingsObject(
    Class settingsClass,
    Class modeClass,
    const CLVirtualDisplayModeSpec * _Nullable modes,
    NSUInteger modeCount,
    BOOL hiDPI
) {
    if (modeCount == 0 || modes == NULL) {
        return nil;
    }
    NSMutableArray *modeObjects = [[NSMutableArray alloc] initWithCapacity:modeCount];
    for (NSUInteger i = 0; i < modeCount; i++) {
        id<CLPrivateVirtualDisplayModeObjC> modeObj =
            [((id<CLPrivateVirtualDisplayModeObjC>)[modeClass alloc])
                initWithWidth:modes[i].width
                       height:modes[i].height
                  refreshRate:modes[i].refreshRate];
        if (modeObj == nil) {
            return nil;
        }
        [modeObjects addObject:modeObj];
    }
    id<CLPrivateVirtualDisplaySettingsObjC> settings =
        [((id<CLPrivateVirtualDisplaySettingsObjC>)[settingsClass alloc]) init];
    if (settings == nil) {
        return nil;
    }
    [settings setHiDPI:(hiDPI ? 1u : 0u)];
    [settings setModes:modeObjects];
    return settings;
}

@implementation CLVirtualDisplayHandle {
    id _Nullable _rawDisplay;
    CGDirectDisplayID _displayID;
}

- (instancetype)initWithRawDisplay:(id)rawDisplay displayID:(CGDirectDisplayID)displayID {
    self = [super init];
    if (self != nil) {
        _rawDisplay = rawDisplay;
        _displayID = displayID;
    }
    return self;
}

- (CGDirectDisplayID)displayID {
    return _displayID;
}

+ (nullable instancetype)createWithName:(NSString *)name
                         descriptorSpec:(CLVirtualDisplayDescriptorSpec)spec
                                  modes:(const CLVirtualDisplayModeSpec * _Nullable)modes
                              modeCount:(NSUInteger)modeCount
                                  hiDPI:(BOOL)hiDPI
                                  queue:(nullable dispatch_queue_t)queue
                     terminationHandler:(nullable void (^)(void))terminationHandler
{
    CLResolvedVirtualDisplayClasses resolved = CLResolveDefaultClasses();
    if (!resolved.supported || modeCount == 0 || modes == NULL) {
        return nil;
    }

    // Hold +1 ARC reference outside @autoreleasepool so temporary descriptor,
    // mode, and settings objects drain immediately while the display stays alive.
    __block id retainedDisplay = nil;
    __block CGDirectDisplayID assignedID = kCGNullDirectDisplay;

    @autoreleasepool {
        id<CLPrivateVirtualDisplayDescriptorObjC> descriptor =
            [((id<CLPrivateVirtualDisplayDescriptorObjC>)[resolved.descriptorClass alloc]) init];
        if (descriptor == nil) {
            return nil;
        }
        [descriptor setName:name];
        [descriptor setMaxPixelsWide:spec.maxPixelsWide];
        [descriptor setMaxPixelsHigh:spec.maxPixelsHigh];
        [descriptor setSizeInMillimeters:spec.sizeInMillimeters];
        [descriptor setVendorID:spec.vendorID];
        [descriptor setProductID:spec.productID];
        [descriptor setSerialNum:spec.serialNum];

        if (queue != nil && [descriptor respondsToSelector:@selector(setQueue:)]) {
            [descriptor setQueue:queue];
        }
        if (terminationHandler != nil && [descriptor respondsToSelector:@selector(setTerminationHandler:)]) {
            void (^copiedHandler)(void) = [terminationHandler copy];
            [descriptor setTerminationHandler:^(__unused id a, __unused id b) {
                copiedHandler();
            }];
        }

        id settings = CLBuildSettingsObject(resolved.settingsClass, resolved.modeClass, modes, modeCount, hiDPI);
        if (settings == nil) {
            return nil;
        }

        id<CLPrivateVirtualDisplayObjC> display =
            [((id<CLPrivateVirtualDisplayObjC>)[resolved.displayClass alloc]) initWithDescriptor:descriptor];
        if (display == nil) {
            return nil;
        }

        CGDirectDisplayID displayID = [display displayID];
        if (displayID == kCGNullDirectDisplay || displayID == UINT32_MAX) {
            return nil;
        }

        if (![display applySettings:settings]) {
            return nil;
        }

        retainedDisplay = display;
        assignedID = displayID;
    }

    if (retainedDisplay == nil || assignedID == kCGNullDirectDisplay) {
        return nil;
    }
    return [[CLVirtualDisplayHandle alloc] initWithRawDisplay:retainedDisplay displayID:assignedID];
}

- (BOOL)applyModes:(const CLVirtualDisplayModeSpec * _Nullable)modes
         modeCount:(NSUInteger)modeCount
             hiDPI:(BOOL)hiDPI
{
    if (_rawDisplay == nil || modeCount == 0 || modes == NULL) {
        return NO;
    }
    CLResolvedVirtualDisplayClasses resolved = CLResolveDefaultClasses();
    if (!resolved.supported) {
        return NO;
    }
    __block BOOL applied = NO;
    @autoreleasepool {
        id settings = CLBuildSettingsObject(resolved.settingsClass, resolved.modeClass, modes, modeCount, hiDPI);
        if (settings != nil) {
            applied = [((id<CLPrivateVirtualDisplayObjC>)_rawDisplay) applySettings:settings];
        }
    }
    return applied;
}

- (void)destroy {
    @autoreleasepool {
        _rawDisplay = nil;
    }
}

- (void)dealloc {
    @autoreleasepool {
        _rawDisplay = nil;
    }
}

@end
