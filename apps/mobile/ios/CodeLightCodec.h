#import <Foundation/Foundation.h>

#if !defined(CODELIGHT_CODEC_STANDALONE) && __has_include(<React/RCTBridgeModule.h>)
#import <React/RCTBridgeModule.h>
#define CODELIGHT_CODEC_HAS_REACT 1
#else
#define CODELIGHT_CODEC_HAS_REACT 0
#endif

NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT const NSUInteger CodeLightCodecMaxDecodedBytes;
FOUNDATION_EXPORT const NSUInteger CodeLightCodecMaxPendingRequests;
FOUNDATION_EXPORT const NSUInteger CodeLightCodecMaxReservedBytes;

// This input is already authenticated by the caller. No crypto or JSON parsing.
FOUNDATION_EXPORT NSString * _Nullable CodeLightDecodeAuthenticatedBody(
    NSData *body, NSUInteger expectedBytes, BOOL gzip,
    NSMutableDictionary<NSString *, NSNumber *> * _Nullable metrics,
    NSError * _Nullable * _Nullable error);

#if CODELIGHT_CODEC_HAS_REACT
@interface CodeLightCodec : NSObject <RCTBridgeModule>
#else
@interface CodeLightCodec : NSObject
#endif
- (void)submitAuthenticatedPayload:(NSDictionary *)request
                         success:(void (^)(NSDictionary *result))success
                         failure:(void (^)(NSString *code, NSError *error))failure;
@end
NS_ASSUME_NONNULL_END
