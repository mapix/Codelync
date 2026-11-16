export const DESKTOP_TEXT_LIMIT = 2048;

export type DesktopTextDraft = { text: string; revision: number };

/** Native UTF-16 units match the Mac input bound; never truncate an IME draft. */
export function desktopTextSubmission(draft: DesktopTextDraft): DesktopTextDraft | null {
    return draft.text.length > 0 && draft.text.length <= DESKTOP_TEXT_LIMIT ? { ...draft } : null;
}

/** Remove only a confirmed, unchanged prefix; edits to that prefix stay visible. */
export function acknowledgeDesktopText(current: DesktopTextDraft, submitted: DesktopTextDraft, prefixUnchanged = false): string {
    if (current.revision === submitted.revision && current.text === submitted.text) return '';
    if (prefixUnchanged && current.text.length > submitted.text.length && current.text.startsWith(submitted.text)) return current.text.slice(submitted.text.length);
    return current.text;
}
