#import "CodelyncCodec.h"
#import <CoreFoundation/CoreFoundation.h>
#include <zlib.h>
#include <time.h>
#include <cmath>

const NSUInteger CodelyncCodecMaxDecodedBytes = 8 * 1024 * 1024;
const NSUInteger CodelyncCodecMaxPendingRequests = 2;
const NSUInteger CodelyncCodecMaxReservedBytes = 16 * 1024 * 1024 + 2;

static double CodecNow(void) {
  struct timespec value; clock_gettime(CLOCK_MONOTONIC, &value);
  return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}
static NSError *CodecError(NSString *code) {
  return [NSError errorWithDomain:@"CodelyncCodec" code:1 userInfo:@{
    @"code": code, NSLocalizedDescriptionKey: @"Authenticated payload decoding failed."
  }];
}
static NSString *CodecFail(NSString *code, NSError **error) {
  if (error) *error = CodecError(code); return nil;
}
static uint32_t Little32(const uint8_t *value) {
  return (uint32_t)value[0] | (uint32_t)value[1] << 8 | (uint32_t)value[2] << 16 | (uint32_t)value[3] << 24;
}
// Strict UTF-8 boundaries exclude overlong encodings, surrogates and >U+10FFFF.
static BOOL ValidUTF8(const uint8_t *bytes, NSUInteger size) {
  for (NSUInteger at = 0; at < size;) {
    uint8_t first = bytes[at++];
    if (first < 0x80) continue;
    NSUInteger count;
    if (first >= 0xc2 && first <= 0xdf) count = 1;
    else if (first >= 0xe0 && first <= 0xef) count = 2;
    else if (first >= 0xf0 && first <= 0xf4) count = 3;
    else return NO;
    if (size - at < count) return NO;
    uint8_t second = bytes[at];
    if ((second & 0xc0) != 0x80 || (first == 0xe0 && second < 0xa0) ||
        (first == 0xed && second >= 0xa0) || (first == 0xf0 && second < 0x90) ||
        (first == 0xf4 && second >= 0x90)) return NO;
    for (NSUInteger index = 1; index < count; index++) if ((bytes[at + index] & 0xc0) != 0x80) return NO;
    at += count;
  }
  return YES;
}

static const int8_t kBase64DecodeTable[128] = {
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
  52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
  -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
  15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
  -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
  41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
};

// Rejects whitespace, non-alphabet chars, misplaced '=', and non-zero trailing pad bits without re-encoding.
static BOOL IsCanonicalBase64(NSString *value) {
  NSUInteger length = value.length;
  if (length == 0) return YES;
  if (length % 4 != 0) return NO;
  unichar fourthLast = [value characterAtIndex:length - 4];
  unichar thirdLast = [value characterAtIndex:length - 3];
  unichar secondLast = [value characterAtIndex:length - 2];
  unichar last = [value characterAtIndex:length - 1];
  if (fourthLast >= 128 || kBase64DecodeTable[fourthLast] < 0) return NO;
  if (last == '=') {
    if (thirdLast >= 128 || kBase64DecodeTable[thirdLast] < 0) return NO;
    if (secondLast == '=') {
      if ((kBase64DecodeTable[thirdLast] & 0x0f) != 0) return NO;
    } else {
      if (secondLast >= 128 || kBase64DecodeTable[secondLast] < 0 || (kBase64DecodeTable[secondLast] & 0x03) != 0) return NO;
    }
  } else {
    if (thirdLast >= 128 || kBase64DecodeTable[thirdLast] < 0 ||
        secondLast >= 128 || kBase64DecodeTable[secondLast] < 0 ||
        last >= 128 || kBase64DecodeTable[last] < 0) return NO;
  }
  NSUInteger prefixLength = length - 4;
  if (prefixLength == 0) return YES;
  const char *ascii = CFStringGetCStringPtr((__bridge CFStringRef)value, kCFStringEncodingASCII);
  if (ascii) {
    for (NSUInteger index = 0; index < prefixLength; index++) {
      uint8_t ch = (uint8_t)ascii[index];
      if (ch >= 128 || kBase64DecodeTable[ch] < 0) return NO;
    }
    return YES;
  }
  unichar chunk[4096];
  for (NSUInteger offset = 0; offset < prefixLength; offset += 4096) {
    NSUInteger count = prefixLength - offset < 4096 ? prefixLength - offset : 4096;
    CFStringGetCharacters((__bridge CFStringRef)value, CFRangeMake((CFIndex)offset, (CFIndex)count), chunk);
    for (NSUInteger index = 0; index < count; index++) {
      unichar ch = chunk[index];
      if (ch >= 128 || kBase64DecodeTable[ch] < 0) return NO;
    }
  }
  return YES;
}

NSString *CodelyncDecodeAuthenticatedBody(NSData *body, NSUInteger expectedBytes, BOOL gzip,
                                         NSMutableDictionary<NSString *, NSNumber *> *metrics, NSError **error) {
  double began = CodecNow();
  if (![body isKindOfClass:[NSData class]] || body.length > CodelyncCodecMaxDecodedBytes || expectedBytes > CodelyncCodecMaxDecodedBytes)
    return CodecFail(@"E_CODEC_TOO_LARGE", error);
  NSData *owned = [body isKindOfClass:[NSMutableData class]] ? [body copy] : body;
  NSData *decoded = owned;
  if (gzip) {
    const uint8_t *bytes = (const uint8_t *)owned.bytes;
    if (owned.length < 18 || bytes[0] != 31 || bytes[1] != 139 || bytes[2] != 8 || bytes[3] != 0)
      return CodecFail(@"E_CODEC_GZIP", error);
    if (Little32(bytes + owned.length - 4) != expectedBytes) return CodecFail(@"E_CODEC_LENGTH", error);
    NSMutableData *output = [NSMutableData dataWithLength:expectedBytes + 1];
    z_stream stream = {};
    stream.next_in = (Bytef *)owned.bytes; stream.avail_in = (uInt)owned.length;
    stream.next_out = (Bytef *)output.mutableBytes; stream.avail_out = (uInt)output.length;
    if (inflateInit2(&stream, MAX_WBITS + 16) != Z_OK) return CodecFail(@"E_CODEC_NATIVE", error);
    int status = inflate(&stream, Z_FINISH);
    NSUInteger count = stream.total_out, remaining = stream.avail_in;
    inflateEnd(&stream);
    // zlib validates the gzip trailer CRC and ISIZE; exactly one member is allowed.
    if (count != expectedBytes) return CodecFail(@"E_CODEC_LENGTH", error);
    if (status != Z_STREAM_END || remaining != 0) return CodecFail(@"E_CODEC_GZIP", error);
    [output setLength:expectedBytes]; decoded = output;
  } else if (owned.length != expectedBytes) return CodecFail(@"E_CODEC_LENGTH", error);
  double inflated = CodecNow();
  const uint8_t *bytes = (const uint8_t *)decoded.bytes;
  if (!ValidUTF8(bytes, decoded.length)) return CodecFail(@"E_CODEC_UTF8", error);
  NSString *text = [[NSString alloc] initWithBytes:bytes length:decoded.length encoding:NSUTF8StringEncoding];
  if (!text) return CodecFail(@"E_CODEC_UTF8", error);
  // Foundation may consume a BOM itself. Normalize to exactly TextDecoder's
  // one-leading-BOM rule, preserving a second BOM as an ordinary scalar.
  NSUInteger sourceBOMs = 0;
  while ((sourceBOMs + 1) * 3 <= decoded.length && bytes[sourceBOMs * 3] == 0xef &&
         bytes[sourceBOMs * 3 + 1] == 0xbb && bytes[sourceBOMs * 3 + 2] == 0xbf) sourceBOMs++;
  NSUInteger targetBOMs = sourceBOMs ? sourceBOMs - 1 : 0, resultBOMs = 0;
  while (resultBOMs < text.length && [text characterAtIndex:resultBOMs] == 0xfeff) resultBOMs++;
  if (resultBOMs > targetBOMs) text = [text substringFromIndex:resultBOMs - targetBOMs];
  else if (resultBOMs < targetBOMs) {
    NSString *prefix = [@"" stringByPaddingToLength:targetBOMs - resultBOMs withString:@"\ufeff" startingAtIndex:0];
    text = [prefix stringByAppendingString:text];
  }
  double ended = CodecNow();
  if (metrics) [metrics addEntriesFromDictionary:@{ @"inflateMs": @(inflated - began), @"utf8Ms": @(ended - inflated),
    @"workMs": @(ended - began), @"inputBytes": @(owned.length), @"outputBytes": @(expectedBytes) }];
  return text;
}

@implementation CodelyncCodec {
  NSLock *_budgetLock;
  NSUInteger _pendingRequests;
  NSUInteger _reservedBytes;
  dispatch_queue_t _worker;
}
- (instancetype)init {
  if ((self = [super init])) {
    _budgetLock = [NSLock new];
    _worker = dispatch_queue_create("io.learnings.codelync.payload-codec", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}
#if CODELYNC_CODEC_HAS_REACT
RCT_EXPORT_MODULE(CodelyncCodec)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0); }
RCT_EXPORT_METHOD(decodeAuthenticatedPayload:(NSDictionary *)request
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [self submitAuthenticatedPayload:request success:^(NSDictionary *result) { resolve(result); } failure:^(NSString *code, NSError *error) { reject(code, @"Authenticated payload decoding failed.", error); }];
}
#endif
- (void)submitAuthenticatedPayload:(NSDictionary *)request success:(void (^)(NSDictionary *))success failure:(void (^)(NSString *, NSError *))failure {
  NSSet *allowed = [NSSet setWithArray:@[@"bodyBase64", @"expectedBytes", @"compression", @"includeMetrics"]];
  if (![request isKindOfClass:[NSDictionary class]] || ![[NSSet setWithArray:request.allKeys] isSubsetOfSet:allowed]) {
    failure(@"E_CODEC_REQUEST", CodecError(@"E_CODEC_REQUEST")); return;
  }
  NSString *body = request[@"bodyBase64"], *compression = request[@"compression"];
  NSNumber *expected = request[@"expectedBytes"], *include = request[@"includeMetrics"];
  if (![body isKindOfClass:[NSString class]] || ![compression isKindOfClass:[NSString class]] || ![@[@"none", @"gzip"] containsObject:compression] ||
      ![expected isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)expected) == CFBooleanGetTypeID() ||
      !std::isfinite(expected.doubleValue) || expected.doubleValue < 0 || expected.doubleValue != floor(expected.doubleValue) || expected.doubleValue > CodelyncCodecMaxDecodedBytes ||
      (include && (![include isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)include) != CFBooleanGetTypeID()))) {
    failure(@"E_CODEC_REQUEST", CodecError(@"E_CODEC_REQUEST")); return;
  }
  NSUInteger maximumBase64 = ((CodelyncCodecMaxDecodedBytes + 2) / 3) * 4;
  if (body.length > maximumBase64 || body.length % 4 != 0) { failure(@"E_CODEC_INPUT", CodecError(@"E_CODEC_INPUT")); return; }
  NSUInteger padding = body.length && [body characterAtIndex:body.length - 1] == '=' ? 1 : 0;
  if (padding && body.length > 1 && [body characterAtIndex:body.length - 2] == '=') padding++;
  NSUInteger encodedEstimate = body.length / 4 * 3 - padding;
  NSUInteger size = expected.unsignedIntegerValue, reserve = encodedEstimate + size + 1;
  [_budgetLock lock];
  BOOL busy = _pendingRequests >= CodelyncCodecMaxPendingRequests || reserve > CodelyncCodecMaxReservedBytes - _reservedBytes;
  if (!busy) { _pendingRequests++; _reservedBytes += reserve; }
  NSUInteger pendingAtAdmission = _pendingRequests, reservedAtAdmission = _reservedBytes;
  [_budgetLock unlock];
  if (busy) { failure(@"E_CODEC_BUSY", CodecError(@"E_CODEC_BUSY")); return; }
  NSString *ownedBody = [body copy]; BOOL gzip = [compression isEqualToString:@"gzip"], diagnostics = include.boolValue;
  double queued = CodecNow();
  dispatch_async(_worker, ^{
    @autoreleasepool {
      @try {
        double started = CodecNow();
        if (!IsCanonicalBase64(ownedBody)) { failure(@"E_CODEC_INPUT", CodecError(@"E_CODEC_INPUT")); return; }
        NSData *encoded = [[NSData alloc] initWithBase64EncodedString:ownedBody options:0];
        if (!encoded || encoded.length != encodedEstimate) { failure(@"E_CODEC_INPUT", CodecError(@"E_CODEC_INPUT")); return; }
        double base64Ended = CodecNow();
        NSMutableDictionary *metrics = diagnostics ? [NSMutableDictionary dictionary] : nil;
        NSError *error = nil;
        NSString *text = CodelyncDecodeAuthenticatedBody(encoded, size, gzip, metrics, &error);
        if (!text) { failure(error.userInfo[@"code"] ?: @"E_CODEC_NATIVE", error ?: CodecError(@"E_CODEC_NATIVE")); return; }
        if (diagnostics) { metrics[@"base64Ms"] = @(base64Ended - started); metrics[@"queueMs"] = @(started - queued);
          metrics[@"pendingAtAdmission"] = @(pendingAtAdmission); metrics[@"reservedBytesAtAdmission"] = @(reservedAtAdmission); }
        success(diagnostics ? @{ @"text": text, @"metrics": metrics } : @{ @"text": text });
      } @catch (__unused NSException *exception) {
        // Neither an exception description nor a payload can enter an error.
        failure(@"E_CODEC_NATIVE", CodecError(@"E_CODEC_NATIVE"));
      } @finally {
        [_budgetLock lock]; _pendingRequests--; _reservedBytes -= reserve; [_budgetLock unlock];
      }
    }
  });
}
@end
