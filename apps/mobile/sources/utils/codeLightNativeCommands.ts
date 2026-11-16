import type { Metadata } from '@/sync/storageTypes';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';
import { isCodeLightSessionSource } from './codeLightSourceScope';

export function codeLightSourceCommands(metadata: Metadata | null | undefined) {
    const bridge = metadata?.bridge, controls = metadata?.nativeControls;
    if (bridge?.source.app === 'claude-desktop') return [];
    if (!isNoninvasiveBridge(metadata) || !isCodeLightSessionSource(bridge?.source, bridge?.controlMode) || bridge?.sourceStatus !== 'connected'
        || typeof bridge.source.runtimeGeneration !== 'string' || !bridge.source.runtimeGeneration.trim() || controls?.compatibility?.supported !== true
        || controls.compatibility.app !== bridge.source.app || controls.commands?.available !== true || controls.commands.source !== `original-${bridge.source.app}`) return [];
    return controls.commands.items;
}

export type CodeLightSlashSubmission =
    | { kind: 'message' }
    | { kind: 'native-item' }
    | { kind: 'native-action'; command: { name: string; arguments: string } }
    | { kind: 'model-picker' }
    | { kind: 'blocked'; reason: 'unsupported' | 'unknown' | 'unavailable' | 'busy' };

/** The absence of an executable catalogue contract can never turn a slash
 * command into ordinary model text. A multi-component absolute path is not a
 * slash command. */
export function codeLightSlashSubmission(metadata: Metadata | null | undefined, draft: string): CodeLightSlashSubmission {
    if (!isNoninvasiveBridge(metadata)) return { kind: 'message' };
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_:.-]*)(?:\s+([\s\S]*))?$/.exec(draft.trim());
    if (!match) return { kind: 'message' };
    const catalogue = codeLightSourceCommands(metadata);
    const selected = catalogue.find(command => command.name === match[1]);
    if (!selected) return { kind: 'blocked', reason: catalogue.length ? 'unknown' : 'unavailable' };
    if (selected.execution === 'native-item') return { kind: 'native-item' };
    if (selected.execution === 'unsupported' || !selected.execution) return { kind: 'blocked', reason: 'unsupported' };
    if (selected.execution === 'model-picker') return { kind: 'model-picker' };
    if (!metadata?.capabilities?.rpcMethods?.includes('source-command')) return { kind: 'blocked', reason: 'unavailable' };
    if (selected.requiresIdle && metadata.bridge?.currentTurnId !== null) return { kind: 'blocked', reason: 'busy' };
    const argumentsText = match[2] ?? '';
    if (selected.name === 'compact' && argumentsText.trim()) return { kind: 'blocked', reason: 'unsupported' };
    return { kind: 'native-action', command: { name: match[1], arguments: argumentsText } };
}

/** Returns true only when the slash input has been consumed outside the normal
 * source message route. Selection and rejection never modify a draft. */
export function handleCodeLightSlashSubmission(metadata: Metadata | null | undefined, draft: string, actions: {
    nativeAction(command: { name: string; arguments: string }): void;
    modelPicker(): void;
    blocked(reason: 'unsupported' | 'unknown' | 'unavailable' | 'busy'): void;
}): boolean {
    const choice = codeLightSlashSubmission(metadata, draft);
    if (choice.kind === 'message' || choice.kind === 'native-item') return false;
    if (choice.kind === 'native-action') actions.nativeAction(choice.command);
    else if (choice.kind === 'model-picker') actions.modelPicker();
    else actions.blocked(choice.reason);
    return true;
}

/** Only a catalogue-confirmed native action can bypass ordinary input admission.
 * Native item commands remain normal explicit source messages. */
export function codeLightNativeCommand(metadata: Metadata | null | undefined, draft: string): { name: string; arguments: string } | null {
    const choice = codeLightSlashSubmission(metadata, draft);
    return choice.kind === 'native-action' ? choice.command : null;
}
