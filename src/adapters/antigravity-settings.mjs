import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const exec = promisify(execFile);
const SUPPORTED_VERSION = '2.31.2';
const INFO_KEYS = ['name', 'modelFacingText', 'type', 'icon', 'definitionPath', 'displayName', 'plugin'];
/** @param {unknown} value @returns {value is Value} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @param {number} [limit] */
function bounded(value, limit = 512) { return typeof value === 'string' && value.length <= limit ? value : ''; }

/** Static version of the actual verified owner's containing application.
 * @param {Value} runtime @returns {Promise<string|null>} */
export async function readAntigravityAppVersion(runtime) {
  const binary = runtime.binary ?? runtime.executable;
  if (typeof binary !== 'string' || !binary.endsWith('/Contents/Resources/bin/language_server')) return null;
  const app = binary.slice(0, -'/Contents/Resources/bin/language_server'.length);
  try {
    const result = await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { maxBuffer: 4096 });
    const version = result.stdout.trim(); return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch { return null; }
}

/** @param {Value} reply @returns {Value[]} */
export function antigravityModels(reply) {
  if (!Array.isArray(reply.clientModelConfigs) || reply.clientModelConfigs.length > 512) throw new BridgeError('native-model-catalog-unavailable', 'The original Antigravity catalogue is invalid.');
  const seen = new Set(), models = [];
  for (const entry of reply.clientModelConfigs) {
    if (!record(entry) || entry.disabled === true || !record(entry.modelOrAlias)) continue;
    const choice = typeof entry.modelOrAlias.model === 'string' ? { model: entry.modelOrAlias.model } : typeof entry.modelOrAlias.alias === 'string' ? { alias: entry.modelOrAlias.alias } : null;
    const id = bounded(entry.modelId) || bounded(choice?.model || choice?.alias), label = bounded(entry.label);
    if (!choice || !id || !label || seen.has(id)) continue;
    seen.add(id); models.push({ id, label, nativeIdentity: choice, reasoningEfforts: [], defaultReasoningEffort: null });
  }
  return models;
}

/** @param {Value} reply @returns {Value[]} */
export function antigravitySlashCommands(reply) {
  if (!Array.isArray(reply.commands) || reply.commands.length > 1024) throw new BridgeError('native-command-catalog-unavailable', 'The original command catalogue is invalid.');
  const seen = new Set(), commands = [];
  for (const definition of reply.commands) {
    const info = definition?.info, name = bounded(info?.name, 128);
    if (!record(info) || !/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(name) || seen.has(name)) continue;
    const skill = info.type === 'SLASH_COMMAND_TYPE_SKILL' || info.type === 2;
    const system = info.type === 'SLASH_COMMAND_TYPE_SYSTEM' || info.type === 1;
    // No text-backed/native skill contract means a desktop-only operation.
    const executable = !!(skill && (bounded(info.definitionPath, 4096) || bounded(info.modelFacingText, 262144)) || system && bounded(info.modelFacingText, 262144));
    if (!executable) continue;
    const nativeInfo = Object.fromEntries(INFO_KEYS.filter(key => info[key] !== undefined).map(key => [key, info[key]]));
    seen.add(name); commands.push({ name, description: bounded(definition.description, 4096), type: skill ? 'skill' : 'system', nativeInfo });
  }
  return commands;
}

/** Native settings and definitions are read from the bound owner, never from a
 * CLI or the phone's guessed defaults. Definitions stay on this Mac. */
export class AntigravitySettings {
  /** @param {{rpc:Value,readVersion?:(runtime:Value)=>Promise<string|null>}} options */
  constructor(options) { this.rpc = options.rpc; this.readVersion = options.readVersion ?? readAntigravityAppVersion; this.catalogues = /** @type {Map<string,Value>} */ (new Map()); }
  /** @returns {Promise<Value>} */
  async compatibility() {
    const runtime = await this.rpc.runtime(), appVersion = await this.readVersion(runtime);
    return { app: 'antigravity', appVersion, protocol: 'antigravity-connect', protocolVersion: 1, supported: appVersion === SUPPORTED_VERSION };
  }
  /** @param {string} id @param {Value} view @param {Value} [context] */
  async read(id, view, context = {}) {
    const options = { expectedGeneration: view.ownerGeneration, ...(context.expectedHostId ? { expectedHostId: context.expectedHostId } : {}) };
    const compatibility = await this.compatibility();
    const reply = await this.rpc.call('GetCascadeModelConfigData', {}, options), models = antigravityModels(reply);
    /** @type {Value[]} */ let commands = [];
    let commandsKnown = false;
    /** @type {string[]} */ let blockedCommands = [];
    try {
      const reply = await this.rpc.call('GetSlashCommands', { cascadeId: id, workspaceUris: view.workspaceUris ?? [] }, options);
      commands = antigravitySlashCommands(reply); commandsKnown = true;
      blockedCommands = reply.commands.filter((/** @type {Value} */ command) => !commands.some(entry => entry.name === command.info?.name)).map((/** @type {Value} */ command) => bounded(command.info?.name, 128)).filter(Boolean);
    } catch { /* Unavailable commands never fall back to another app. */ }
    const hasNativeInput = Array.isArray(view.rows) && view.rows.some((/** @type {Value} */ row) => row.role === 'user');
    const identity = view.nativeModel ?? (hasNativeInput ? null : reply.defaultOverrideModelConfig?.modelOrAlias);
    const match = models.find(model => JSON.stringify(model.nativeIdentity) === JSON.stringify(identity));
    const key = JSON.stringify([context.expectedHostId ?? '', view.ownerGeneration, id]);
    this.catalogues.delete(key); this.catalogues.set(key, { models, commands, blockedCommands });
    while (this.catalogues.size > 32) { const oldest = this.catalogues.keys().next().value; if (oldest === undefined) break; this.catalogues.delete(oldest); }
    return { compatibility, model: { available: compatibility.supported && !!match && models.length > 0,
      current: match ? { model: match.id, reasoningEffort: null, modelProvider: 'antigravity' } : null,
      models: models.map(({ nativeIdentity: _native, ...model }) => model), catalogSource: 'original-antigravity', selectionMode: 'next-message', selectionState: 'native',
      ...(!compatibility.supported ? { reason: 'app-version-unverified' } : !match ? { reason: 'native-current-model-unavailable' } : {}) },
      commands: { available: compatibility.supported && commandsKnown, source: 'original-antigravity', items: compatibility.supported ? commands.map(({ nativeInfo: _native, ...command }) => ({ ...command, execution: 'native-item' })) : [] } };
  }
  /** @param {string} id @param {Value} view @param {Value} payload @param {Value} [context] */
  async validate(id, view, payload, context = {}) {
    const controls = await this.read(id, view, context);
    if (!controls.model.available || payload.reasoningEffort !== null || !controls.model.models.some((/** @type {Value} */ model) => model.id === payload.model)) throw new BridgeError('unsupported-model-settings', 'This model is not in the original Antigravity catalogue.');
    const catalogue = this.catalogues.get(JSON.stringify([context.expectedHostId ?? '', view.ownerGeneration, id]));
    const nativeIdentity = catalogue?.models.find((/** @type {Value} */ model) => model.id === payload.model)?.nativeIdentity;
    return { staged: true, applied: false, nativeIdentity, controls: { ...controls, model: { ...controls.model, observedCurrent: controls.model.current,
      current: { model: payload.model, reasoningEffort: null, modelProvider: 'antigravity' }, selectionState: 'staged' } } };
  }
  /** Freeze a selected native model and slash definition for explicit dispatch.
   * @param {string} id @param {Value} view @param {Value} payload @param {Value} [context] */
  async message(id, view, payload, context = {}) {
    if (!payload.model && !/^\/[A-Za-z0-9][A-Za-z0-9_:.-]*(?:\s|$)/.test(payload.text)) return { items: [{ text: payload.text }] };
    const controls = await this.read(id, view, context);
    const catalogue = this.catalogues.get(JSON.stringify([context.expectedHostId ?? '', view.ownerGeneration, id]));
    /** @type {Value[]} */ let items = [{ text: payload.text }];
    const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(payload.text.trim());
    if (command) {
      const selected = catalogue?.commands.find((/** @type {Value} */ entry) => entry.name === command[1]);
      if (catalogue?.blockedCommands.includes(command[1])) throw new BridgeError('unsupported-action', 'This desktop command has no verified remote submission contract.');
      if (selected) {
        if (!controls.compatibility.supported) throw new BridgeError('unsupported-action', 'This application command contract is unverified.');
        items = [{ item: { slashCommand: { info: selected.nativeInfo } } }, ...(command[2] ? [{ text: command[2] }] : [])];
      }
    }
    if (!payload.model) return { items };
    const model = catalogue?.models.find((/** @type {Value} */ entry) => entry.id === payload.model);
    if (!controls.model.available || !model) throw new BridgeError('unsupported-model-settings', 'The selected Antigravity model is unavailable.');
    if (payload.modelIdentity && JSON.stringify(payload.modelIdentity) !== JSON.stringify(model.nativeIdentity)) throw new BridgeError('settings-conflict', 'The native model catalogue changed after this selection.');
    return { items, cascadeConfig: { plannerConfig: { requestedModel: model.nativeIdentity } }, selectedNativeModel: model.nativeIdentity };
  }
  dispose() { this.catalogues.clear(); }
}
