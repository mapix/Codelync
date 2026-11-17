import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
/** Local Mac UI choices share one serialized transition, separate from peer/native RPC. */
export class SourceSubscriptionCommands {
  /** @param {{settings:import('./source-subscriptions.mjs').DesktopSourceSubscriptions,daemon:()=>Value|null,notify:(value:Value)=>void,changed?:()=>void,isClosing?:()=>boolean,settingsOnly?:boolean}} options */
  constructor(options) { this.options = options; this.tail = Promise.resolve(); }
  publish() { this.options.notify({ type: 'source-subscriptions', configuration: this.options.settings.snapshot() }); }
  /** @param {unknown} input */
  handle(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const command = /** @type {Value} */ (input);
    if (!['set-source-subscriptions', 'reload-source-subscriptions'].includes(command.type)) return false;
    if (typeof command.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(command.requestId)) return true;
    const requestId = command.requestId;
    const operation = this.tail.then(async () => {
      const daemon = this.options.daemon();
      if (this.options.isClosing?.() || !daemon && !this.options.settingsOnly) throw new BridgeError('source-unavailable', 'Codelync source choices are unavailable.', 503);
      if (command.type === 'set-source-subscriptions') await this.options.settings.setEnabledApps(command.apps);
      else await this.options.settings.reload();
      this.publish(); daemon?.fenceSourceSubscriptions(); this.options.changed?.();
      try { if (daemon) await daemon.reconcileSourceSubscriptions(); }
      finally { this.options.changed?.(); }
      if (!this.options.settings.snapshot().known) throw new BridgeError('source-subscriptions-unavailable', 'The source choices could not be read.', 503);
    });
    this.tail = operation.then(() => {
      this.publish(); this.options.notify({ type: 'source-subscriptions-result', requestId, ok: true });
    }, error => {
      this.publish();
      const code = !this.options.settings.snapshot().known ? 'source-subscriptions-unavailable'
        : error?.code === 'source-subscriptions-save-failed' || error?.code === 'invalid-source-subscriptions' ? 'source-subscriptions-save-failed' : 'source-subscriptions-apply-pending';
      this.options.notify({ type: 'source-subscriptions-result', requestId, ok: false, code });
    });
    return true;
  }
  idle() { return this.tail; }
}
