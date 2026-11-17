/** The shipped native identity owns the product boundary even while Expo's
 * manifest is unavailable during cold startup. */
export function resolveNativeSourceMode(applicationId: string | null | undefined, configured: boolean | undefined): boolean | undefined {
    if (applicationId === 'com.learnings.codelync') return true;
    return configured;
}
