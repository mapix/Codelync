import { join } from 'node:path';
import { ConnectionChannelsManager } from '../network/connection-channels.mjs';
import { DesktopSourceSubscriptions } from './source-subscriptions.mjs';
import { SourceSubscriptionCommands } from './source-subscription-commands.mjs';
import { desktopConfiguration } from './remote-desktop.mjs';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';

/** @typedef {Record<string,any>} Value */
/** One local-pipe settings writer; no credentials, native runtimes or listeners. */
export class MacSettingsService {
  /** @param {{state:string,notify:(value:Value)=>void,validateRelay?:(url:string,signal?:AbortSignal)=>Promise<string>}} options */
  constructor(options) {
    this.options = options; this.closed = false; this.tail = Promise.resolve();
    this.desktop = desktopConfiguration({ enabled: false, mode: 'local' });
    this.desktopKnown = false;
    this.sources = new DesktopSourceSubscriptions({ path: join(options.state, 'source-subscriptions.json') });
    this.sourceCommands = new SourceSubscriptionCommands({ settings: this.sources, daemon: () => null,
      notify: options.notify, settingsOnly: true, isClosing: () => this.closed });
    this.connections = new ConnectionChannelsManager({ state: options.state, settingsOnly: true, cloudflared: '',
      upstreamFor: () => '', probesFor: () => ({ verify: async () => { throw Error('settings-only-operation-unavailable'); } }),
      startLocal: async () => { throw Error('settings-only-operation-unavailable'); }, validateRelay: options.validateRelay });
    this.connections.on('configuration', configuration => options.notify({ type: 'access-configuration', configuration }));
  }
  async start() {
    await this.sources.reload(); this.sourceCommands.publish();
    await this.connections.load();
    try {
      const saved = await readOptionalPrivateJson(join(this.options.state, 'desktop/remote-desktop.json'));
      if (saved) this.desktop = desktopConfiguration(saved);
      this.desktopKnown = true;
      this.publishDesktop();
    } catch { this.publishDesktop('desktop-settings-unavailable'); }
    if (!this.closed) this.options.notify({ type: 'settings-ready' });
  }
  /** @param {string} [error] */
  publishDesktop(error) {
    const value = this.desktop;
    this.options.notify({ type: 'desktop-status', status: { version: 1, enabled: value.enabled, mode: value.mode,
      url: value.url, apiKey: value.apiKey, hasSecret: !!value.apiSecret, connected: false,
      quality: { width: 1920, fps: 30 }, permissions: null }, ...(error ? { error } : {}) });
  }
  /** @param {unknown} raw */
  handle(raw) {
    if (this.closed || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (this.sourceCommands.handle(raw)) return true;
    const command = /** @type {Value} */ (raw);
    const types = /** @type {Record<string,string>} */ ({ 'set-enabled-channels': 'access-result', 'configure-relay': 'access-result',
      'configure-desktop': 'desktop-result', 'desktop-permission': 'desktop-result' });
    if (typeof command.type !== 'string' || !Object.hasOwn(types, command.type)) return false;
    const type = types[command.type];
    if (typeof command.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(command.requestId)) return true;
    const requestId = command.requestId;
    const operation = this.tail.then(async () => {
      if (this.closed) throw Error('settings-service-unavailable');
      if (command.type === 'set-enabled-channels') await this.connections.setEnabled(command.channels);
      else if (command.type === 'configure-relay') await this.connections.configureRelay({ serverUrl: command.serverUrl,
        ...(typeof command.token === 'string' ? { token: command.token } : {}) });
      else if (command.type === 'desktop-permission') throw Error('settings-only-operation-unavailable');
      else {
        if (!this.desktopKnown || !command.configuration || typeof command.configuration !== 'object' || Array.isArray(command.configuration)) throw Error('desktop-settings-unavailable');
        const change = command.configuration;
        if (change.mode === 'external' && (change.url !== this.desktop.url || change.apiKey !== this.desktop.apiKey) && !change.apiSecret) throw Error('desktop-server-secret-required');
        const next = desktopConfiguration({ ...this.desktop, ...change });
        await writeDurablePrivateJson(join(this.options.state, 'desktop/remote-desktop.json'), next);
        this.desktop = next; this.publishDesktop();
      }
      this.options.notify({ type, requestId, ok: true });
    });
    this.tail = operation.catch(error => {
      this.options.notify({ type, requestId, ok: false,
        code: error?.message === 'settings-only-operation-unavailable' ? error.message : type === 'desktop-result' ? 'desktop-configuration-failed' : 'connection-channel-update-failed' });
    });
    return true;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([this.tail, this.sourceCommands.idle(), this.connections.close()]);
  }
}
