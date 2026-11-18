#import <Foundation/Foundation.h>
#import "CodelyncCodec.h"
#include <zlib.h>
#include <atomic>
#include <cstdio>

static NSUInteger checks = 0;
static void Check(BOOL condition, const char *name) {
  checks++; if (!condition) { fprintf(stderr, "native-codec-check-failed:%s\n", name); exit(1); }
}
static NSData *Gzip(NSData *data) {
  z_stream stream = {}; Check(deflateInit2(&stream, 6, Z_DEFLATED, MAX_WBITS + 16, 8, Z_DEFAULT_STRATEGY) == Z_OK, "gzip-init");
  NSMutableData *result = [NSMutableData dataWithLength:compressBound(data.length) + 64];
  stream.next_in = (Bytef *)data.bytes; stream.avail_in = (uInt)data.length;
  stream.next_out = (Bytef *)result.mutableBytes; stream.avail_out = (uInt)result.length;
  Check(deflate(&stream, Z_FINISH) == Z_STREAM_END, "gzip-finish"); [result setLength:stream.total_out]; deflateEnd(&stream); return result;
}
static NSString *Decode(NSData *body, NSUInteger length, BOOL gzip, NSError **error) { return CodelyncDecodeAuthenticatedBody(body, length, gzip, nil, error); }
static void Rejected(NSData *body, NSUInteger length, BOOL gzip, NSString *code, const char *name) {
  NSError *error = nil; NSString *result = Decode(body, length, gzip, &error);
  Check(!result && error != nil && (!code || [error.userInfo[@"code"] isEqualToString:code]), name);
  Check(![error.localizedDescription containsString:@"synthetic-private-content"], "error-content-free");
}
static NSData *BenchmarkBody(void) {
  NSMutableString *text = [NSMutableString string];
  uint32_t seed = 0x12345678;
  for (NSUInteger index = 0; index < 10000; index++) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; [text appendFormat:@"Native Unicode 正文 😀 · %08x ", seed]; }
  NSMutableDictionary *payload = [@{ @"version": @1, @"rows": @[@{ @"id": @"synthetic", @"text": text }], @"padding": @"" } mutableCopy];
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  const NSUInteger target = 475932; Check(encoded.length < target, "benchmark-base-bound");
  payload[@"padding"] = [@"" stringByPaddingToLength:target - encoded.length withString:@"x" startingAtIndex:0];
  encoded = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil]; Check(encoded.length == target, "benchmark-exact-length"); return encoded;
}
static NSDictionary *AwaitRequest(CodelyncCodec *codec, NSDictionary *request, NSString **reason) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSDictionary *value = nil; __block NSString *code = nil;
  [codec submitAuthenticatedPayload:request success:^(NSDictionary *result) { value = result; dispatch_semaphore_signal(done); }
    failure:^(NSString *failure, NSError *) { code = failure; dispatch_semaphore_signal(done); }];
  Check(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0, "request-complete");
  if (reason) *reason = code; return value;
}
int main(void) {
  @autoreleasepool {
    NSData *unicode = [@"{\"text\":\"Native Unicode 正文 😀\"}" dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil; NSString *expected = [[NSString alloc] initWithData:unicode encoding:NSUTF8StringEncoding];
    Check([Decode(unicode, unicode.length, NO, &error) isEqualToString:expected], "unicode-plain");
    NSData *gzip = Gzip(unicode); Check([Decode(gzip, unicode.length, YES, &error) isEqualToString:expected], "unicode-gzip");
    const uint8_t bom[] = {0xef, 0xbb, 0xbf}; NSMutableData *withBOM = [NSMutableData dataWithBytes:bom length:3]; [withBOM appendData:unicode];
    Check([Decode(withBOM, withBOM.length, NO, &error) isEqualToString:expected], "single-bom");
    NSMutableData *twoBOM = [NSMutableData dataWithBytes:bom length:3]; [twoBOM appendData:withBOM];
    NSString *twice = Decode(twoBOM, twoBOM.length, NO, &error); Check(twice.length == expected.length + 1 && [twice characterAtIndex:0] == 0xfeff, "double-bom-one-preserved");
    const uint8_t malformed[][4] = {{0xff,0,0,0},{0xc0,0xaf,0,0},{0xe0,0x80,0xaf,0},{0xed,0xa0,0x80,0},{0xf4,0x90,0x80,0x80},{0xf0,0x9f,0,0},{0x80,0,0,0}};
    const NSUInteger sizes[] = {1,2,3,3,4,2,1};
    for (NSUInteger index = 0; index < 7; index++) {
      NSData *bad = [NSData dataWithBytes:malformed[index] length:sizes[index]];
      Rejected(bad, bad.length, NO, @"E_CODEC_UTF8", "invalid-utf8");
      Rejected(Gzip(bad), bad.length, YES, @"E_CODEC_UTF8", "invalid-utf8-after-valid-gzip");
    }
    Rejected(unicode, unicode.length - 1, NO, @"E_CODEC_LENGTH", "plain-length-mismatch");
    NSMutableData *badCRC = [gzip mutableCopy]; ((uint8_t *)badCRC.mutableBytes)[badCRC.length - 8] ^= 1;
    Rejected(badCRC, unicode.length, YES, @"E_CODEC_GZIP", "gzip-crc");
    Rejected([gzip subdataWithRange:NSMakeRange(0, gzip.length - 5)], unicode.length, YES, nil, "gzip-truncated");
    NSMutableData *trailing = [gzip mutableCopy]; const uint8_t zero = 0; [trailing appendBytes:&zero length:1];
    Rejected(trailing, unicode.length, YES, nil, "gzip-trailing");
    NSMutableData *multiple = [gzip mutableCopy]; [multiple appendData:gzip]; Rejected(multiple, unicode.length, YES, @"E_CODEC_GZIP", "gzip-multimember");
    NSMutableData *flags = [gzip mutableCopy]; ((uint8_t *)flags.mutableBytes)[3] = 8; Rejected(flags, unicode.length, YES, @"E_CODEC_GZIP", "gzip-flags");
    NSMutableData *large = [NSMutableData dataWithLength:CodelyncCodecMaxDecodedBytes + 1]; memset(large.mutableBytes, 'x', large.length);
    Rejected(large, large.length, NO, @"E_CODEC_TOO_LARGE", "decoded-bound");
    NSMutableData *bomb = [Gzip(large) mutableCopy]; uint32_t claimed = (uint32_t)CodelyncCodecMaxDecodedBytes;
    for (NSUInteger index = 0; index < 4; index++) ((uint8_t *)bomb.mutableBytes)[bomb.length - 4 + index] = (claimed >> (index * 8)) & 255;
    Rejected(bomb, claimed, YES, @"E_CODEC_LENGTH", "gzip-overflow-detection-byte");
    NSData *data = BenchmarkBody(), *compressed = Gzip(data); NSString *reference = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSMutableArray *times = [NSMutableArray array]; double inflateTotal = 0, utf8Total = 0;
    for (NSUInteger sample = 0; sample < 30; sample++) { @autoreleasepool {
      NSMutableDictionary *metrics = [NSMutableDictionary dictionary]; NSString *decoded = CodelyncDecodeAuthenticatedBody(compressed, data.length, YES, metrics, &error);
      Check([decoded isEqualToString:reference], "benchmark-roundtrip"); [times addObject:metrics[@"workMs"]];
      inflateTotal += [metrics[@"inflateMs"] doubleValue]; utf8Total += [metrics[@"utf8Ms"] doubleValue];
    }}
    [times sortUsingSelector:@selector(compare:)];
    CodelyncCodec *codec = [CodelyncCodec new]; dispatch_group_t group = dispatch_group_create();
    std::atomic_uint successes{0}, busy{0}, asyncFailures{0}; std::atomic_bool offMain{true};
    auto successCount = &successes, busyCount = &busy, failureCount = &asyncFailures; auto offMainFlag = &offMain;
    // Same synthetic body is shared; admission happens before allocating native payload buffers.
    NSMutableData *maxBody = [[large subdataWithRange:NSMakeRange(0, CodelyncCodecMaxDecodedBytes)] mutableCopy]; ((uint8_t *)maxBody.mutableBytes)[0] = '"'; ((uint8_t *)maxBody.mutableBytes)[maxBody.length - 1] = '"'; NSString *base64 = [maxBody base64EncodedStringWithOptions:0];
    for (NSUInteger index = 0; index < 32; index++) {
      dispatch_group_enter(group);
      [codec submitAuthenticatedPayload:@{ @"bodyBase64": base64, @"expectedBytes": @(maxBody.length), @"compression": @"none", @"includeMetrics": @YES }
        success:^(NSDictionary *result) {
          if ([NSThread isMainThread]) offMainFlag->store(false);
          Check([result[@"metrics"][@"pendingAtAdmission"] unsignedIntegerValue] <= CodelyncCodecMaxPendingRequests, "pending-bound");
          Check([result[@"metrics"][@"reservedBytesAtAdmission"] unsignedIntegerValue] <= CodelyncCodecMaxReservedBytes, "byte-budget");
          successCount->fetch_add(1); dispatch_group_leave(group);
        } failure:^(NSString *code, NSError *) { if ([code isEqualToString:@"E_CODEC_BUSY"]) busyCount->fetch_add(1); else failureCount->fetch_add(1); dispatch_group_leave(group); }];
    }
    Check(dispatch_group_wait(group, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0, "queue-complete");
    Check(successes.load() > 0 && busy.load() > 0 && asyncFailures.load() == 0, "queue-rejects-excess"); Check(offMain.load(), "worker-off-main");
    CodelyncCodec *requestCodec = [CodelyncCodec new]; NSString *reason = nil;
    NSDictionary *validRequest = @{ @"bodyBase64": [unicode base64EncodedStringWithOptions:0], @"expectedBytes": @(unicode.length), @"compression": @"none" };
    Check([AwaitRequest(requestCodec, validRequest, &reason)[@"text"] isEqualToString:expected] && reason == nil, "async-request-roundtrip");
    for (NSDictionary *patch in @[@{ @"expectedBytes": @YES }, @{ @"expectedBytes": @1.5 }, @{ @"expectedBytes": @(-1) }, @{ @"compression": @"zip" }, @{ @"includeMetrics": @1 }, @{ @"nonce": @"not-a-codec-input" }]) {
      NSMutableDictionary *request = [validRequest mutableCopy]; [request addEntriesFromDictionary:patch];
      Check(AwaitRequest(requestCodec, request, &reason) == nil && [reason isEqualToString:@"E_CODEC_REQUEST"], "async-request-shape");
    }
    Check(AwaitRequest(requestCodec, @{ @"bodyBase64": @"AB==", @"expectedBytes": @1, @"compression": @"none" }, &reason) == nil && [reason isEqualToString:@"E_CODEC_INPUT"], "noncanonical-base64");
    Check([AwaitRequest(requestCodec, @{ @"bodyBase64": @"AQ==", @"expectedBytes": @1, @"compression": @"none" }, &reason)[@"text"] isEqualToString:@"\x01"] && reason == nil, "canonical-base64-pad2");
    Check([AwaitRequest(requestCodec, @{ @"bodyBase64": @"AQI=", @"expectedBytes": @2, @"compression": @"none" }, &reason)[@"text"] isEqualToString:@"\x01\x02"] && reason == nil, "canonical-base64-pad1");
    for (NSString *bad64 in @[@"AQB=", @"AAB=", @"====", @"A===", @"=AAA", @"AA=A", @"AQ==\n", @"AQ ==", @"AQ-_"]) {
      NSNumber *badBytes = bad64.length == 4 && ![bad64 hasPrefix:@"="] && ![bad64 hasPrefix:@"A="] ? @2 : @1;
      Check(AwaitRequest(requestCodec, @{ @"bodyBase64": bad64, @"expectedBytes": badBytes, @"compression": @"none" }, &reason) == nil && [reason isEqualToString:@"E_CODEC_INPUT"], "reject-noncanonical-or-bad-base64");
    }
    // Exercise non-contiguous UTF-16 CFString chunked fallback path (>4096 chars).
    unichar *utf16Chars = (unichar *)malloc(sizeof(unichar) * 8192);
    for (NSUInteger idx = 0; idx < 8192; idx++) utf16Chars[idx] = (idx % 4 == 0) ? 'Q' : 'Q';
    NSString *nonAsciiPtrBody = [[NSString alloc] initWithCharactersNoCopy:utf16Chars length:8192 freeWhenDone:YES];
    NSDictionary *chunkedResult = AwaitRequest(requestCodec, @{ @"bodyBase64": nonAsciiPtrBody, @"expectedBytes": @(6144), @"compression": @"none" }, &reason);
    Check(chunkedResult != nil && [chunkedResult[@"text"] length] == 6144 && reason == nil, "canonical-base64-chunked-utf16");
    NSMutableString *mutableBody = [[unicode base64EncodedStringWithOptions:0] mutableCopy];
    dispatch_semaphore_t copyDone = dispatch_semaphore_create(0); __block NSString *copiedText = nil;
    [requestCodec submitAuthenticatedPayload:@{ @"bodyBase64": mutableBody, @"expectedBytes": @(unicode.length), @"compression": @"none" }
      success:^(NSDictionary *result) { copiedText = result[@"text"]; dispatch_semaphore_signal(copyDone); }
      failure:^(NSString *, NSError *) { dispatch_semaphore_signal(copyDone); }];
    [mutableBody setString:@"changed-after-submission"];
    Check(dispatch_semaphore_wait(copyDone, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0 && [copiedText isEqualToString:expected], "owned-body-snapshot");
    NSMutableData *half = [NSMutableData dataWithLength:4 * 1024 * 1024]; memset(half.mutableBytes, 'x', half.length);
    ((uint8_t *)half.mutableBytes)[0] = '"'; ((uint8_t *)half.mutableBytes)[half.length - 1] = '"';
    CodelyncCodec *pendingCodec = [CodelyncCodec new]; NSString *half64 = [half base64EncodedStringWithOptions:0];
    std::atomic_uint pendingSuccess{0}, pendingBusy{0}, pendingFailure{0}, maxPendingSeen{0};
    auto pendingSuccessCount = &pendingSuccess, pendingBusyCount = &pendingBusy, pendingFailureCount = &pendingFailure, maxPendingCount = &maxPendingSeen;
    dispatch_group_t pendingGroup = dispatch_group_create();
    for (NSUInteger index = 0; index < 32; index++) {
      dispatch_group_enter(pendingGroup);
      [pendingCodec submitAuthenticatedPayload:@{ @"bodyBase64": half64, @"expectedBytes": @(half.length), @"compression": @"none", @"includeMetrics": @YES }
        success:^(NSDictionary *result) {
          unsigned count = [result[@"metrics"][@"pendingAtAdmission"] unsignedIntValue];
          if (count > maxPendingCount->load()) maxPendingCount->store(count);
          pendingSuccessCount->fetch_add(1); dispatch_group_leave(pendingGroup);
        } failure:^(NSString *code, NSError *) { if ([code isEqualToString:@"E_CODEC_BUSY"]) pendingBusyCount->fetch_add(1); else pendingFailureCount->fetch_add(1); dispatch_group_leave(pendingGroup); }];
    }
    Check(dispatch_group_wait(pendingGroup, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0, "pending-queue-complete");
    Check(pendingSuccess.load() == 2 && maxPendingSeen.load() == 2 && pendingBusy.load() == 30 && pendingFailure.load() == 0, "pending-count-bound-independent-of-byte-budget");
    NSDictionary *report = @{ @"synthetic": @YES, @"checks": @(checks), @"logicalBytes": @(data.length), @"gzipBytes": @(compressed.length),
      @"samples": @30, @"nativeMedianMs": times[15], @"nativeP95Ms": times[28], @"meanInflateMs": @(inflateTotal / 30), @"meanUTF8Ms": @(utf8Total / 30),
      @"queueSucceeded": @(successes.load()), @"queueBusy": @(busy.load()), @"pendingQueueSucceeded": @(pendingSuccess.load()), @"pendingQueueBusy": @(pendingBusy.load()),
      @"maxPendingObserved": @(maxPendingSeen.load()), @"maxPending": @(CodelyncCodecMaxPendingRequests), @"maxReservedBytes": @(CodelyncCodecMaxReservedBytes), @"workerOffMain": @(offMain.load()) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:report options:0 error:nil]; fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout);
  }
  return 0;
}
