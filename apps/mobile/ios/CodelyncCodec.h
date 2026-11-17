#import <Foundation/Foundation.h>

#if !defined(CODELYNC_CODEC_STANDALONE) && __has_include(<React/RCTBridgeModule.h>)
#import <React/RCTBridgeModule.h>
#define CODELYNC_CODEC_HAS_REACT 1
#else
#define CODELYNC_CODEC_HAS_REACT 0
#endif

NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT const NSUInteger CodelyncCodecMaxDecodedBytes;
FOUNDATION_EXPORT const NSUInteger CodelyncCodecMaxPendingRequests;
FOUNDATION_EXPORT const NSUInteger CodelyncCodecMaxReservedBytes;

// This input is already authenticated by the caller. No crypto or JSON parsing.
FOUNDATION_EXPORT NSString * _Nullable CodelyncDecodeAuthenticatedBody(
    NSData *body, NSUInteger expectedBytes, BOOL gzip,
    NSMutableDictionary<NSString *, NSNumber *> * _Nullable metrics,
    NSError * _Nullable * _Nullable error);

#if CODELYNC_CODEC_HAS_REACT
@interface CodelyncCodec : NSObject <RCTBridgeModule>
#else
@interface CodelyncCodec : NSObject
#endif
- (void)submitAuthenticatedPayload:(NSDictionary *)request
                         success:(void (^)(NSDictionary *result))success
                         failure:(void (^)(NSString *code, NSError *error))failure;
@end
NS_ASSUME_NONNULL_END
