/** Web/test transport; native resolves the Expo streaming implementation. */
export const fetchAttachmentBlob: typeof fetch = (input, init) => fetch(input, init);
