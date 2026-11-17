import { nativeTaskDigestText, nativeTaskTransferApply } from '@codelync/wire/native-tasks';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { NativeTaskReadReplySchema, NativeTasksSchema, type NativeTasks } from './nativeTasks';

/** Shared structural validation precedes native SHA256 and atomic cache use. */
export async function materializeNativeTaskReply(baseline: NativeTasks | null, raw: unknown): Promise<NativeTasks> {
    const response = NativeTaskReadReplySchema.parse(raw);
    const result = NativeTasksSchema.parse(nativeTaskTransferApply(baseline, response));
    if (result.digest && await digestStringAsync(CryptoDigestAlgorithm.SHA256, nativeTaskDigestText(result)) !== result.digest) throw Error('Native task digest mismatch');
    return result;
}
