/** Native browser/Node TextDecoder stays the default outside React Native. */
export function decodePeerText(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
