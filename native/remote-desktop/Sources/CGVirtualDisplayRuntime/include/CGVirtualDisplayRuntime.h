#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// Logical 1x mode entry passed to CGVirtualDisplayMode. When hiDPI == YES,
/// macOS exposes 2x Retina backing modes for every mode where 2 * width <= maxPixelsWide
/// and 2 * height <= maxPixelsHigh.
typedef struct {
    uint32_t width;
    uint32_t height;
    double refreshRate;
} CLVirtualDisplayModeSpec;

/// Hardware descriptor parameters for CGVirtualDisplayDescriptor.
typedef struct {
    uint32_t maxPixelsWide;
    uint32_t maxPixelsHigh;
    CGSize sizeInMillimeters;
    uint32_t vendorID;
    uint32_t productID;
    uint32_t serialNum;
} CLVirtualDisplayDescriptorSpec;

/// Cached runtime capability check for CGVirtualDisplay, CGVirtualDisplayDescriptor,
/// CGVirtualDisplaySettings, and CGVirtualDisplayMode plus all required instance selectors.
FOUNDATION_EXPORT BOOL CLVirtualDisplayRuntimeIsSupported(void);

/// Uncached selector and class validation helper parameterized by class names so unit tests
/// can deterministically exercise missing-class and missing-selector fallback paths.
FOUNDATION_EXPORT BOOL CLVirtualDisplayRuntimeProbeClassNames(
    NSString *displayClassName,
    NSString *descriptorClassName,
    NSString *settingsClassName,
    NSString *modeClassName
);

/// ARC-safe opaque wrapper around a dynamically instantiated CGVirtualDisplay object.
/// Emits zero static OBJC_CLASS_$_CGVirtualDisplay* linker references.
@interface CLVirtualDisplayHandle : NSObject

@property (nonatomic, readonly) CGDirectDisplayID displayID;

- (instancetype)init NS_UNAVAILABLE;

+ (nullable instancetype)createWithName:(NSString *)name
                         descriptorSpec:(CLVirtualDisplayDescriptorSpec)spec
                                  modes:(const CLVirtualDisplayModeSpec * _Nullable)modes
                              modeCount:(NSUInteger)modeCount
                                  hiDPI:(BOOL)hiDPI
                                  queue:(nullable dispatch_queue_t)queue
                     terminationHandler:(nullable void (^)(void))terminationHandler;

- (BOOL)applyModes:(const CLVirtualDisplayModeSpec * _Nullable)modes
         modeCount:(NSUInteger)modeCount
             hiDPI:(BOOL)hiDPI;

- (void)destroy;

@end

NS_ASSUME_NONNULL_END
