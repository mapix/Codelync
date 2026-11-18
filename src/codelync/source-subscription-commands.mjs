import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
/** Local Mac UI choices share one serialized transition, separate from peer/native RPC. */
export class SourceSubscriptionCommands {
  /** @param {{settings:import('./source-subscriptions.mjs').DesktopSourceSubscriptions,daemon:()=>Value|null,notify:(value:Value)=>void,changed?:()=>void,isClosing?:()=>boolean,settingsOnly?:boolean}} options */
  constructor(options) {
    this.options = options;
    this.tail = Promise.resolve();
    this.reconcilePending = false;
    /** @type {Value|null} */ this.reconciledDaemon = null;
  }
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
      const before = this.options.settings.snapshot();
      if (command.type === 'set-source-subscriptions') await this.options.settings.setEnabledApps(command.apps);
      else await this.options.settings.reload();
      const after = this.options.settings.snapshot();
      if (!after.known) {
        this.reconcilePending = Boolean(daemon);
        this.publish(); daemon?.fenceSourceSubscriptions(); this.options.changed?.();
        try { if (daemon) await daemon.reconcileSourceSubscriptions(); }
        finally { this.options.changed?.(); }
        throw new BridgeError('source-subscriptions-unavailable', 'The source choices could not be read.', 503);
      }
      const noopSet = command.type === 'set-source-subscriptions' && before.known && before.revision === after.revision && !this.reconcilePending && this.reconciledDaemon === daemon;
      if (noopSet) return;
      this.reconcilePending = Boolean(daemon);
      this.publish(); daemon?.fenceSourceSubscriptions(); this.options.changed?.();
      try {
        if (daemon) {
          await daemon.reconcileSourceSubscriptions();
          this.reconciledDaemon = daemon;
          this.reconcilePending = false;
        }
      } finally { this.options.changed?.(); }
    });
    this.tail = operation.then(() => {
      try { this.publish(); } catch {}
      try { this.options.notify({ type: 'source-subscriptions-result', requestId, ok: true }); } catch {}
    }, error => {
      try { this.publish(); } catch {}
      const code = error?.code === 'source-subscriptions-save-failed' || error?.code === 'invalid-source-subscriptions' ? 'source-subscriptions-save-failed'
        : !this.options.settings.snapshot().known ? 'source-subscriptions-unavailable' : 'source-subscriptions-apply-pending';
      try { this.options.notify({ type: 'source-subscriptions-result', requestId, ok: false, code }); } catch {}
    });
    return true;
  }
  idle() { return this.tail; }
}
